const TEST_LOBBY_EMAILS = ["meghana@hackclub.com", "mihir@hackclub.com"];

export function canUseTestLobby(email: string) {
  return TEST_LOBBY_EMAILS.includes(email);
}
