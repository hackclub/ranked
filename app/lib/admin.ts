// Staff access is configured per deployment, not written into the source.
// Each variable is a comma-separated list of Hack Club Auth email addresses;
// an unset or empty variable means nobody has that role.
//
// Server-only: client code must use the `isAdmin` flag that /api/auth/me
// returns instead of importing this module.
function staffEmails(variable: string) {
  return (process.env[variable] ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isStaff(variable: string, email: string | null | undefined) {
  if (!email) return false;
  return staffEmails(variable).includes(email.trim().toLowerCase());
}

export function isAdmin(email: string | null | undefined): boolean {
  return isStaff("ADMIN_EMAILS", email);
}

// Deliberately a separate list from ADMIN_EMAILS: being able to adjust ELO or
// read the audit log must not imply being able to watch players' recordings.
export function isRecordingReviewer(email: string | null | undefined): boolean {
  return isStaff("RECORDING_REVIEWER_EMAILS", email);
}
