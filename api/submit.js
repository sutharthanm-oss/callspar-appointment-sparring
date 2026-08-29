// POST /api/submit
// Body: { agentCode, sessionId, mode, language, difficulty, starterId, assessment: {...} }
// Looks up the Agent record by Agent Code, then creates a Training Session + linked Coaching Report.
// If the assessment flagged an effective-but-unapproved technique, also logs it to the Flagged
// Techniques base for Admin review, and pings Telegram if configured.

const BASE_ID = "appAHmJKtNi508bIw";
const TABLE_AGENTS = "tblV0xfgpFQxyRVSS";
const TABLE_TRAINING_SESSIONS = "tblAQaxG82bN14ppM";
const TABLE_COACHING_REPORTS = "tblxfhYiBFcG5McId";

const FLAGS_BASE_ID = "appYUxhPpFYrNObIE";
const TABLE_FLAGGED_TECHNIQUES = "tblvuoEG5GEntAZ5s";

async function airtableFetch(baseId, path, token, options = {}) {
  const resp = await fetch(`https://api.airtable.com/v0/${baseId}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
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

async function notifyTelegram(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return; // Not configured â silently skip, never block submission on this.
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    // Notification failure should never fail the actual submission.
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server is missing AIRTABLE_TOKEN. Set it in your hosting provider's environment variables." });
    return;
  }

  const { agentCode, sessionId, mode, language, difficulty, starterId, assessment, transcript, realName, cueTimeline } = req.body || {};
  if (!agentCode || !sessionId || !assessment) {
    res.status(400).json({ error: "Missing agentCode, sessionId, or assessment in request body." });
    return;
  }

  try {
    // 1. Find the Agent record by Agent Code
    const filterFormula = encodeURIComponent(`{Agent Code} = "${agentCode}"`);
    const agentSearch = await airtableFetch(BASE_ID, `${TABLE_AGENTS}?filterByFormula=${filterFormula}`, token);
    if (!agentSearch.records || agentSearch.records.length === 0) {
      res.status(404).json({ error: `Agent Code "${agentCode}" not found in Airtable.` });
      return;
    }
    const agentRecordId = agentSearch.records[0].id;

    // 2. Duplicate check on Session ID
    const dupFormula = encodeURIComponent(`{Session ID} = "${sessionId}"`);
    const dupSearch = await airtableFetch(BASE_ID, `${TABLE_TRAINING_SESSIONS}?filterByFormula=${dupFormula}`, token);
    if (dupSearch.records && dupSearch.records.length > 0) {
      res.status(409).json({ error: `Session ID "${sessionId}" was already submitted.` });
      return;
    }

    // 3. Create the Training Session
    const sessionCreate = await airtableFetch(BASE_ID, TABLE_TRAINING_SESSIONS, token, {
      method: "POST",
      body: JSON.stringify({
        typecast: true,
        records: [
          {
            fields: {
              "Session ID": sessionId,
              "Agent Code Submitted": agentCode,
              "Mode": mode,
              "Delivery": "Text",
              "Language": language,
              "Difficulty": difficulty,
              "Communication Score": assessment.communication,
              "Objection Score": assessment.objection_handling,
              "Closing Score": assessment.appointment_closing,
              "Listening Score": assessment.listening,
              "Questioning Score": assessment.questioning,
              "Confidence Score": assessment.confidence_tone,
              "Script Intent Score": assessment.script_intent,
              "Appointment Outcome": assessment.appointment_outcome,
              "Compliance Result": assessment.compliance_result,
              "Compliance Issue": assessment.compliance_issue || "",
              "Full Transcript": transcript || "",
              "Tester Real Name": realName || "",
              "Cue Timeline": cueTimeline || "",
              "Valid Session": true,
              "Agent": [agentRecordId],
            },
          },
        ],
      }),
    });
    const sessionRecordId = sessionCreate.records[0].id;

    // 4. Create the Coaching Report, linked to the session
    await airtableFetch(BASE_ID, TABLE_COACHING_REPORTS, token, {
      method: "POST",
      body: JSON.stringify({
        typecast: true,
        records: [
          {
            fields: {
              "Coaching Report ID": `CR-${sessionId}`,
              "Final Outcome": assessment.appointment_outcome,
              "Overall Score": assessment.overall,
              "Pass or Retry": assessment.pass_status,
              "Category Evidence": [
                `Communication (${assessment.communication}/25): ${assessment.communication_evidence || ""} | Improve: ${assessment.communication_improvement || ""}`,
                `Objection Handling (${assessment.objection_handling}/25): ${assessment.objection_handling_evidence || ""} | Improve: ${assessment.objection_handling_improvement || ""}`,
                `Appointment Closing (${assessment.appointment_closing}/20): ${assessment.appointment_closing_evidence || ""} | Improve: ${assessment.appointment_closing_improvement || ""}`,
                `Listening (${assessment.listening}/10): ${assessment.listening_evidence || ""} | Improve: ${assessment.listening_improvement || ""}`,
                `Questioning (${assessment.questioning}/10): ${assessment.questioning_evidence || ""} | Improve: ${assessment.questioning_improvement || ""}`,
                `Confidence & Tone (${assessment.confidence_tone}/5): ${assessment.confidence_tone_evidence || ""} | Improve: ${assessment.confidence_tone_improvement || ""}`,
                `Script Intent (${assessment.script_intent}/5): ${assessment.script_intent_evidence || ""} | Improve: ${assessment.script_intent_improvement || ""}`,
              ].join("\n"),
              "One Biggest Mistake": assessment.one_biggest_mistake || "",
              "One Highest-Impact Improvement": assessment.highest_impact_improvement || "",
              "All Mistakes": (assessment.all_mistakes || []).map((m) => `- ${m}`).join("\n"),
              "Things Done Well": (assessment.things_done_well || []).map((g) => `- ${g}`).join("\n"),
              "Strongest Sentence": assessment.strongest_sentence || "",
              "Strongest Question": assessment.strongest_question || "",
              "Better Response": assessment.better_response || "",
              "Better Appointment Close": assessment.better_close || "",
              "Recommended Next Starter": starterId,
              "Full Assessment Report": assessment.full_report || "",
              "Training Session": [sessionRecordId],
              "Agent": [agentRecordId],
            },
          },
        ],
      }),
    });

    // 5. Notify Telegram that a session was just completed â separate from the flagged
    // technique alert below, and never lets a notification failure block the submission.
    try {
      const displayName = (realName && realName.trim()) || agentCode;
      const passEmoji = assessment.pass_status === "Pass" ? "â" : "ð";
      const outcomeEmoji = assessment.appointment_outcome === "Secured" ? "ð" : "â";
      await notifyTelegram(
        `${passEmoji} <b>${displayName}</b> just completed a session\n\n` +
        `Score: <b>${assessment.overall}/100</b> â ${assessment.pass_status}\n` +
        `Appointment: ${outcomeEmoji} ${assessment.appointment_outcome}\n` +
        `Mode: ${mode} Â· Difficulty: ${difficulty}\n\n` +
        `<b>Focus area:</b> ${assessment.highest_impact_improvement || "â"}\n\n` +
        `Session: ${sessionId}`
      );
    } catch (notifyErr) {
      // Swallow â a notification failure should never block a successful session submission.
    }

    // 6. If the assessment flagged an effective-but-unapproved technique, log it for Admin
    // review and ping Telegram â but never let a problem here fail the actual submission.
    if (assessment.flagged_technique && assessment.flagged_technique.trim()) {
      try {
        await airtableFetch(FLAGS_BASE_ID, TABLE_FLAGGED_TECHNIQUES, token, {
          method: "POST",
          body: JSON.stringify({
            typecast: true,
            records: [
              {
                fields: {
                  "Flag ID": `FLAG-${sessionId}`,
                  "Session ID": sessionId,
                  "Agent Code": agentCode,
                  "Technique Description": assessment.flagged_technique,
                  "Why It Worked": assessment.flagged_technique_reason || "",
                  "Status": "Pending",
                  "Flagged At": new Date().toISOString(),
                },
              },
            ],
          }),
        });
        await notifyTelegram(
          `ð© <b>New technique flagged for review</b>\n\nAgent: ${agentCode}\nSession: ${sessionId}\n\n${assessment.flagged_technique}\n\n<i>${assessment.flagged_technique_reason || ""}</i>\n\nOpen CallSpar Admin â Flagged Techniques to review.`
        );
      } catch (flagErr) {
        // Swallow â a failed flag/notification should not block a successful session submission.
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
