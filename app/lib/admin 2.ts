const ADMIN_EMAILS = ["meghana@hackclub.com", "mihir@hackclub.com"];

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email);
}
