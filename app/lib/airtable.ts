import type { HackClubAddress } from "@/app/lib/hackclub";

const DEFAULT_BASE_ID = "appWhszMexYwrDfKY";
const DEFAULT_TABLE_ID = "tbl13RI05Gn6NHa3C";
const AIRTABLE_TIMEOUT_MS = 15_000;

type AirtableField = { id: string; name: string; type: string };
type AirtableTable = { id: string; fields: AirtableField[] };

const SUBMISSION_FIELDS = {
  codeUrl: { id: "fldeKLon0520fkSYr", name: "Code URL", type: "url" },
  playableUrl: { id: "fldGa8AO8OI15lJOk", name: "Playable URL", type: "url" },
  firstName: { id: "fldk5pLcr79iI33s2", name: "First Name", type: "singleLineText" },
  lastName: { id: "flddi58VvgE4WjgjZ", name: "Last Name", type: "singleLineText" },
  email: { id: "fldWXpyOdCziKdTp3", name: "Email", type: "email" },
  screenshot: { id: "fldBMnDISxyOm2YMo", name: "Screenshot", type: "multipleAttachments" },
  description: { id: "fldHkfLROIhSl1DLo", name: "Description", type: "richText" },
  githubUsername: { id: "fldZl96UgS4ob9pTl", name: "GitHub Username", type: "singleLineText" },
  line1: { id: "fldxuZLFBKOYlsuRk", name: "Address (Line 1)", type: "singleLineText" },
  line2: { id: "fldHQ1IeK2eYtfRKG", name: "Address (Line 2)", type: "singleLineText" },
  city: { id: "fldNazs73ukGQcatS", name: "City", type: "singleLineText" },
  state: { id: "fldk0PUU9tw42gblQ", name: "State / Province", type: "singleLineText" },
  country: { id: "fldvsPoxLpUgS5Mf2", name: "Country", type: "singleLineText" },
  postalCode: { id: "fldWSPMieVIy9bqzL", name: "ZIP / Postal Code", type: "singleLineText" },
  birthday: { id: "fldMHpmllEfogyO5m", name: "Birthday", type: "date" },
  hoursSpent: { id: "fldXLDwiCGoacnxqm", name: "Optional - Override Hours Spent", type: "number" },
} as const;

// The Description column is rich text, which Airtable renders as Markdown.
// A player's description is plain prose, so its Markdown syntax is escaped —
// otherwise a submission could put live links or fake headings in front of a
// reviewer. A line that would read as a spreadsheet formula once the table is
// exported (leading = + - @) is also defused with a leading apostrophe.
function airtablePlainText(value: string) {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const escaped = line.replace(/[\\`*_~[\]<>|#!]/g, (character) => `\\${character}`);
      return /^\s*[=+\-@]/.test(escaped) ? `'${escaped}` : escaped;
    })
    .join("\n");
}

// Names, addresses and usernames go into plain single-line columns, where
// Markdown means nothing — but they are still values a player controls, and
// the table gets exported to spreadsheets. A cell that starts with = + - @
// (or a tab or carriage return, which spreadsheets skip over before looking)
// is run as a formula there, so it gets the same leading apostrophe. Line
// breaks and other control characters have no business in these fields at all.
function airtableCell(value: string | null | undefined) {
  const flattened = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return /^[=+\-@]/.test(flattened) ? `'${flattened}` : flattened;
}

function configuration() {
  const apiKey = process.env.AIRTABLE_API?.trim();
  if (!apiKey) throw new Error("AIRTABLE_API is required.");
  const baseId = process.env.AIRTABLE_BASE_ID?.trim() || DEFAULT_BASE_ID;
  const tableId = process.env.AIRTABLE_SUBMISSIONS_TABLE_ID?.trim() || DEFAULT_TABLE_ID;
  if (!/^app[A-Za-z0-9]+$/.test(baseId) || !/^tbl[A-Za-z0-9]+$/.test(tableId)) {
    throw new Error("Airtable base or table ID is invalid.");
  }
  return { apiKey, baseId, tableId };
}

async function airtableFetch(url: string, init?: RequestInit) {
  const { apiKey } = configuration();
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...init?.headers },
    cache: "no-store",
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(AIRTABLE_TIMEOUT_MS),
  });
}

async function submissionTable() {
  const { baseId, tableId } = configuration();
  const response = await airtableFetch(
    `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
  );
  if (!response.ok) {
    throw new Error(`Airtable schema lookup failed (${response.status}).`);
  }
  const schema = (await response.json()) as { tables?: AirtableTable[] };
  const table = schema.tables?.find((item) => item.id === tableId);
  if (!table) throw new Error(`Airtable table ${tableId} was not found.`);
  for (const expected of Object.values(SUBMISSION_FIELDS)) {
    const field = table.fields.find((item) => item.id === expected.id);
    if (!field || field.name !== expected.name || field.type !== expected.type) {
      throw new Error(`Airtable field ${expected.name} changed.`);
    }
  }
  return table;
}

export async function createRankedSubmission(input: {
  codeUrl: string;
  playableUrl: string;
  description: string;
  githubUsername: string;
  firstName: string;
  lastName: string;
  email: string;
  birthday: string;
  address: HackClubAddress;
  durationMinutes: number;
  screenshot: File;
}) {
  await submissionTable();
  const { baseId, tableId } = configuration();
  const fields: Record<string, string | number> = {
    [SUBMISSION_FIELDS.codeUrl.id]: input.codeUrl,
    [SUBMISSION_FIELDS.playableUrl.id]: input.playableUrl,
    [SUBMISSION_FIELDS.description.id]: airtablePlainText(input.description),
    [SUBMISSION_FIELDS.githubUsername.id]: airtableCell(input.githubUsername),
    [SUBMISSION_FIELDS.firstName.id]: airtableCell(input.firstName),
    [SUBMISSION_FIELDS.lastName.id]: airtableCell(input.lastName),
    [SUBMISSION_FIELDS.email.id]: input.email,
    [SUBMISSION_FIELDS.birthday.id]: input.birthday,
    [SUBMISSION_FIELDS.line1.id]: airtableCell(input.address.line_1),
    [SUBMISSION_FIELDS.city.id]: airtableCell(input.address.city),
    [SUBMISSION_FIELDS.state.id]: airtableCell(input.address.state),
    [SUBMISSION_FIELDS.country.id]: airtableCell(input.address.country),
    [SUBMISSION_FIELDS.postalCode.id]: airtableCell(input.address.postal_code),
    // Airtable is configured with one decimal place, so 10/30/60-minute
    // rounds become 0.2/0.5/1.0 hours respectively.
    [SUBMISSION_FIELDS.hoursSpent.id]: Number((input.durationMinutes / 60).toFixed(1)),
  };
  const line2 = airtableCell(input.address.line_2);
  if (line2) fields[SUBMISSION_FIELDS.line2.id] = line2;

  // Code URL is unique per player's published build. performUpsert makes a
  // retry safe if Airtable accepted a request but the server lost its response.
  const response = await airtableFetch(
    `https://api.airtable.com/v0/${baseId}/${tableId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [{ fields }],
        performUpsert: { fieldsToMergeOn: [SUBMISSION_FIELDS.codeUrl.id] },
        typecast: true,
        returnFieldsByFieldId: true,
      }),
    },
  );
  const result = (await response.json().catch(() => null)) as
    | { records?: Array<{ id?: string }>; error?: { message?: string } }
    | null;
  const recordId = result?.records?.[0]?.id;
  if (!response.ok || !recordId) {
    throw new Error(
      `Airtable submission failed (${result?.error?.message ?? response.status}).`,
    );
  }

  const uploadResponse = await airtableFetch(
    `https://content.airtable.com/v0/${baseId}/${recordId}/${SUBMISSION_FIELDS.screenshot.id}/uploadAttachment`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "image/png",
        file: Buffer.from(await input.screenshot.arrayBuffer()).toString("base64"),
        filename: "ranked-build.png",
      }),
    },
  );
  if (!uploadResponse.ok) {
    throw new Error(`Airtable screenshot upload failed (${uploadResponse.status}).`);
  }
  return recordId;
}

// Reuses the existing Description field rather than adding a new column —
// no new field id to add to SUBMISSION_FIELDS, so submissionTable()'s strict
// schema check (every expected field must already exist, exactly) can't be
// broken by this. Used to flag a submission as reported for AI-generated
// code after the fact, including on a submission that's already been sent.
export async function updateSubmissionDescription(
  recordId: string,
  description: string,
) {
  const { baseId, tableId } = configuration();
  const response = await airtableFetch(
    `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: { [SUBMISSION_FIELDS.description.id]: airtablePlainText(description) },
        typecast: true,
      }),
    },
  );
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      `Airtable description update failed (${result?.error?.message ?? response.status}).`,
    );
  }
}
