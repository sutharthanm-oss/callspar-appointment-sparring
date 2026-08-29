// GET /api/dashboard?date=YYYY-MM-DD (optional, defaults to today)&range=all (optional)
// Admin-secret protected. Returns every valid session for that day (or all time), aggregated
// per agent, including the prospect used, full category-by-category evidence, every mistake,
// and everything done well — not just a single headline mistake/improvement. Quick Practice
// sessions are included automatically — they're stored identically to any other session.

const BASE_ID = "appAHmJKtNi508bIw";
const TABLE_TRAINING_SESSIONS = "tblAQaxG82bN14ppM";
const TABLE_COACHING_REPORTS = "tblxfhYiBFcG5McId";
const TABLE_PROSPECTS = "tblMpttghkw3QrZ0E";

// Strips any leading bullet-like marker ("•", "-", "*", "1.", "2)") — handles both the old
// "•"-prefixed format and the current "-"-prefixed format this data may have been stored
// with, plus repeats in case a record ended up with more than one layer stacked together.
function stripBulletPrefix(text) {
  let s = String(text || "").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*(?:[•\-*]|\d+[.)])\s*/, "").trim();
  } while (s !== prev);
  return s;
}

function checkAdminSecret(req) {
  const provided = req.headers["x-admin-secret"];
  return provided && process.env.ADMIN_SECRET && provided === process.env.ADMIN_SECRET;
}

async function airtableGet(path, token) {
  const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rawText = await resp.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Airtable returned non-JSON (HTTP ${resp.status}): ${rawText.slice(0, 300)}`);
  }
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Airtable error (HTTP ${resp.status})`);
  }
  return data;
}

// Airtable caps every response at 100 records regardless of how many actually match — it
// signals more data exists via an `offset` token that must be requeried explicitly. Without
// following this, "All Time" would silently truncate to only the most recent 100 sessions
// once the team's usage grows past that.
async function airtableGetAllPages(path, token) {
  let allRecords = [];
  let offset = "";
  do {
    const pageUrl = offset ? `${path}&offset=${offset}` : path;
    const data = await airtableGet(pageUrl, token);
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset || "";
  } while (offset);
  return { records: allRecords };
}

export default async function handler(req, res) {
  // Explicitly forbid caching anywhere in the chain (CDN, proxy, browser) — a stale
  // cached response is otherwise indistinguishable from a real data bug to whoever's
  // looking at the app.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server is missing AIRTABLE_TOKEN." });
    return;
  }
  if (!checkAdminSecret(req)) {
    res.status(401).json({ error: "Invalid admin credentials." });
    return;
  }

  try {
    const dateParam = (req.query && req.query.date) || "";
    const range = (req.query && req.query.range) || "";
    let filterFormula;
    if (range === "all") {
      filterFormula = encodeURIComponent(`{Valid Session} = TRUE()`);
    } else {
      const dateFormula = dateParam
        ? `IS_SAME({Session Date-Time}, DATETIME_PARSE("${dateParam}", "YYYY-MM-DD"), "day")`
        : `IS_SAME({Session Date-Time}, TODAY(), "day")`;
      filterFormula = encodeURIComponent(`AND({Valid Session} = TRUE(), ${dateFormula})`);
    }
    const fields = ["Session ID", "Agent Code Submitted", "Session Date-Time", "Overall Score", "Pass Status", "Mode", "Difficulty", "Appointment Outcome", "Prospect", "Full Transcript", "Tester Real Name", "Cue Timeline"]
      .map((f) => `fields[]=${encodeURIComponent(f)}`).join("&");

    const sessionsData = await airtableGetAllPages(
      `${TABLE_TRAINING_SESSIONS}?filterByFormula=${filterFormula}&${fields}&sort[0][field]=Session%20Date-Time&sort[0][direction]=desc`,
      token
    );

    const sessions = (sessionsData.records || []).map((r) => ({
      sessionId: r.fields["Session ID"] || "",
      agentCode: r.fields["Agent Code Submitted"] || "",
      time: r.fields["Session Date-Time"] || "",
      score: r.fields["Overall Score"] ?? null,
      pass: r.fields["Pass Status"] || "",
      mode: r.fields["Mode"] || "",
      difficulty: r.fields["Difficulty"] || "",
      outcome: r.fields["Appointment Outcome"] || "",
      transcript: r.fields["Full Transcript"] || "",
      realName: r.fields["Tester Real Name"] || "",
      cueTimeline: (() => {
        try {
          const raw = r.fields["Cue Timeline"];
          return raw ? JSON.parse(raw) : null;
        } catch (e) {
          return null;
        }
      })(),
      prospectRecordId: (r.fields["Prospect"] || [])[0] || "",
      prospectName: "",
      prospectLocation: "",
      biggestMistake: "",
      improvement: "",
      categoryEvidence: "",
      allMistakes: [],
      thingsDoneWell: [],
    }));

    // Resolve prospect names/locations. The Prospect Library is small (dozens of records),
    // so fetching it once per request and matching by record ID is simpler and more
    // reliable than per-session lookups.
    const prospectIds = [...new Set(sessions.map((s) => s.prospectRecordId).filter(Boolean))];
    if (prospectIds.length > 0) {
      const prospectFormula = encodeURIComponent("OR(" + prospectIds.map((id) => `RECORD_ID()="${id}"`).join(",") + ")");
      const prospectFields = ["Fictional Name", "Market Type"].map((f) => `fields[]=${encodeURIComponent(f)}`).join("&");
      const prospectData = await airtableGet(`${TABLE_PROSPECTS}?filterByFormula=${prospectFormula}&${prospectFields}`, token);
      const byRecordId = {};
      (prospectData.records || []).forEach((r) => {
        byRecordId[r.id] = { name: r.fields["Fictional Name"] || "", location: r.fields["Market Type"] || "" };
      });
      sessions.forEach((s) => {
        const match = byRecordId[s.prospectRecordId];
        if (match) {
          s.prospectName = match.name;
          s.prospectLocation = match.location;
        }
      });
    }

    // Coaching Reports are named "CR-<sessionId>" by /api/submit.js — use that directly
    // instead of resolving linked-record IDs, which keeps this to a single extra request
    // per batch. Batched in chunks of 30 — an unbatched single formula with one clause per
    // session risks exceeding Airtable's URL length limit once the total session count
    // grows, which would silently fail this whole enrichment step for every session past
    // whatever point the URL became too long.
    if (sessions.length > 0) {
      const BATCH_SIZE = 30;
      const bySessionId = {};
      for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
        const batch = sessions.slice(i, i + BATCH_SIZE);
        const crFormula = encodeURIComponent(
          "OR(" + batch.map((s) => `{Coaching Report ID}="CR-${s.sessionId}"`).join(",") + ")"
        );
        const crFields = ["Coaching Report ID", "One Biggest Mistake", "One Highest-Impact Improvement", "Category Evidence", "All Mistakes", "Things Done Well"]
          .map((f) => `fields[]=${encodeURIComponent(f)}`).join("&");
        const crData = await airtableGetAllPages(`${TABLE_COACHING_REPORTS}?filterByFormula=${crFormula}&${crFields}`, token);
        (crData.records || []).forEach((r) => {
          const crId = r.fields["Coaching Report ID"] || "";
          const sid = crId.replace(/^CR-/, "");
          bySessionId[sid] = {
            mistake: r.fields["One Biggest Mistake"] || "",
            improvement: r.fields["One Highest-Impact Improvement"] || "",
            categoryEvidence: r.fields["Category Evidence"] || "",
            allMistakes: (r.fields["All Mistakes"] || "").split("\n").map((s) => stripBulletPrefix(s)).filter(Boolean),
            thingsDoneWell: (r.fields["Things Done Well"] || "").split("\n").map((s) => stripBulletPrefix(s)).filter(Boolean),
          };
        });
      }
      sessions.forEach((s) => {
        const match = bySessionId[s.sessionId];
        if (match) {
          s.biggestMistake = match.mistake;
          s.improvement = match.improvement;
          s.categoryEvidence = match.categoryEvidence;
          s.allMistakes = match.allMistakes;
          s.thingsDoneWell = match.thingsDoneWell;
        }
      });
    }

    // Aggregate per agent.
    const byAgent = {};
    sessions.forEach((s) => {
      if (!byAgent[s.agentCode]) {
        byAgent[s.agentCode] = { agentCode: s.agentCode, attempts: 0, scores: [], passCount: 0, retryCount: 0, sessions: [] };
      }
      const a = byAgent[s.agentCode];
      a.attempts += 1;
      if (typeof s.score === "number") a.scores.push(s.score);
      if (s.pass === "Pass") a.passCount += 1;
      else if (s.pass === "Retry") a.retryCount += 1;
      a.sessions.push(s);
    });
    const agents = Object.values(byAgent).map((a) => ({
      agentCode: a.agentCode,
      attempts: a.attempts,
      passCount: a.passCount,
      retryCount: a.retryCount,
      avgScore: a.scores.length ? Math.round(a.scores.reduce((x, y) => x + y, 0) / a.scores.length) : null,
      bestScore: a.scores.length ? Math.max(...a.scores) : null,
      sessions: a.sessions,
    })).sort((a, b) => b.attempts - a.attempts);

    const allScores = sessions.map((s) => s.score).filter((s) => typeof s === "number");

    res.status(200).json({
      date: range === "all" ? "All Time" : (dateParam || new Date().toISOString().slice(0, 10)),
      totalSessions: sessions.length,
      uniqueAgents: agents.length,
      averageScore: allScores.length ? Math.round(allScores.reduce((x, y) => x + y, 0) / allScores.length) : null,
      agents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
