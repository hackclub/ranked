const githubHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

export function githubAuthorizationUrl(state: string, challenge: string, redirectUri: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error("GITHUB_CLIENT_ID is required.");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: process.env.GITHUB_REDIRECT_URI ?? redirectUri,
    scope: process.env.GITHUB_OAUTH_SCOPE ?? "repo",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeGitHubCode(code: string, verifier: string, redirectUri: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required.");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: process.env.GITHUB_REDIRECT_URI ?? redirectUri }),
  });
  const token = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !token.access_token) throw new Error(token.error_description ?? "GitHub token exchange failed.");
  const userResponse = await fetch("https://api.github.com/user", { headers: githubHeaders(token.access_token) });
  if (!userResponse.ok) throw new Error(`GitHub profile request failed (${userResponse.status}).`);
  const user = await userResponse.json() as { login: string; avatar_url?: string };
  return { accessToken: token.access_token, login: user.login, avatarUrl: user.avatar_url ?? null };
}

async function githubRequest<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...githubHeaders(token), ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 422 && url.endsWith("/user/repos")) throw new Error("That repository name is already in use on your GitHub account. Choose another name.");
    throw new Error(`GitHub request failed (${response.status}): ${detail.slice(0, 280)}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function publishWebsite(token: string, login: string, requestedName: string, html: string, sourceFiles?: Record<string, string>) {
  const repoName = requestedName.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName === "." || repoName === "..") {
    throw new Error("Repository names may only use letters, numbers, periods, underscores, and hyphens.");
  }
  const repository = await githubRequest<{ html_url: string }>(token, "https://api.github.com/user/repos", {
    method: "POST",
    body: JSON.stringify({ name: repoName, description: "An open-source website built live on Ranked.", homepage: `https://${login}.github.io/${repoName}/`, private: false, has_issues: true, auto_init: false }),
  });

  const putFile = (path: string, content: string, message: string) => githubRequest(token, `https://api.github.com/repos/${login}/${repoName}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), branch: "main" }),
  });

  await putFile("index.html", html, "Publish finished Ranked build");
  await putFile("README.md", `# ${requestedName}\n\nBuilt live on Ranked and published open source.\n`, "Add project README");
  await putFile(".nojekyll", "", "Configure GitHub Pages");
  for (const [name, content] of Object.entries(sourceFiles ?? {})) {
    if (!["index.html", "styles.css", "script.js"].includes(name)) continue;
    await putFile(`source/${name}`, content, `Publish ${name} source`);
  }

  let pagesUrl = `https://${login}.github.io/${repoName}/`;
  try {
    const pages = await githubRequest<{ html_url?: string }>(token, `https://api.github.com/repos/${login}/${repoName}/pages`, {
      method: "POST",
      body: JSON.stringify({ source: { branch: "main", path: "/" } }),
    });
    pagesUrl = pages.html_url ?? pagesUrl;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("409")) throw error;
  }
  return { repositoryUrl: repository.html_url, pagesUrl, repoName };
}
