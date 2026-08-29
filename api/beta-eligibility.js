// POST /api/beta-eligibility
// Body: { realName }
// Returns: { eligible: true/false, securedCount: number }
//
// Eligibility rule (Phase 1, as agreed): 5 or more sessions with Appointment Outcome =
// "Secured", counted under the exact same Tester Real Name, across any sessions (Pass or
// Retry doesn't matter for this specific check). This is fully automatic — no admin flag
// to maintain. The moment someone's 5th secured appointment lands, their very next login
// unlocks the Custom Prospect Avatar option.

const BASE_ID = "appAHmJKtNi508bIw";
const TABLE_TRAINING_SESSIONS = "tblAQaxG82bN14ppM";
const REQUIRED_SECURED_COUNT = 5;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server is missing AIRTABLE_TOKEN." });
    return;
  }

  const { realName } = req.body || {};
  if (!realName || !realName.trim()) {
    res.status(200).json({ eligible: false, securedCount: 0 });
    return;
  }

  try {
    const escapedName = realName.trim().replace(/"/g, '\\"');
    const filterFormula = encodeURIComponent(
      `AND({Tester Real Name} = "${escapedName}", {Appointment Outcome} = "Secured", {Valid Session} = TRUE())`
    );
    const resp = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${TABLE_TRAINING_SESSIONS}?filterByFormula=${filterFormula}&fields[]=Session ID`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || "Airtable request failed");

    const securedCount = (data.records || []).length;
    res.status(200).json({ eligible: securedCount >= REQUIRED_SECURED_COUNT, securedCount });
  } catch (e) {
    // Fail closed — if the eligibility check itself fails, don't show the feature rather
    // than risk showing it to someone who hasn't actually earned it.
    res.status(200).json({ eligible: false, securedCount: 0, error: e.message });
  }
}
