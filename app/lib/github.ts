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

const RANKED_REPO = "hackclubranked";
const isNotFound = (error: unknown) => error instanceof Error && error.message.includes("(404)");

function repoContentsPath(login: string, path = "") {
  return `https://api.github.com/repos/${login}/${RANKED_REPO}/contents/${path}`;
}

async function pathExists(token: string, login: string, path: string) {
  try {
    await githubRequest(token, repoContentsPath(login, path));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// Every player's builds live in one shared "hackclubranked" repo, one folder per match,
// instead of a fresh repo per match cluttering their GitHub account.
async function ensureRankedRepo(token: string, login: string) {
  try {
    return await githubRequest<{ html_url: string }>(token, `https://api.github.com/repos/${login}/${RANKED_REPO}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const repository = await githubRequest<{ html_url: string }>(token, "https://api.github.com/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: RANKED_REPO,
      description: "Live-coded Ranked builds — one folder per match.",
      homepage: `https://${login}.github.io/${RANKED_REPO}/`,
      private: false,
      has_issues: true,
      auto_init: true,
    }),
  });
  await githubRequest(token, repoContentsPath(login, ".nojekyll"), {
    method: "PUT",
    body: JSON.stringify({ message: "Configure GitHub Pages", content: "", branch: "main" }),
  });
  try {
    await githubRequest(token, `https://api.github.com/repos/${login}/${RANKED_REPO}/pages`, {
      method: "POST",
      body: JSON.stringify({ source: { branch: "main", path: "/" } }),
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("409")) throw error;
  }
  return repository;
}

export async function publishWebsite(token: string, login: string, requestedName: string, html: string, sourceFiles?: Record<string, string>) {
  const folderName = requestedName.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(folderName) || folderName === "." || folderName === "..") {
    throw new Error("Build names may only use letters, numbers, periods, underscores, and hyphens.");
  }
  const repository = await ensureRankedRepo(token, login);
  if (await pathExists(token, login, folderName)) {
    throw new Error(`"${folderName}" is already used in your ${RANKED_REPO} repo. Choose another name.`);
  }

  const putFile = (path: string, content: string, message: string) => githubRequest(token, repoContentsPath(login, path), {
    method: "PUT",
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), branch: "main" }),
  });

  await putFile(`${folderName}/index.html`, html, `Publish ${folderName}`);
  await putFile(`${folderName}/README.md`, `# ${folderName}\n\nBuilt live on Ranked and published open source.\n`, `Add README for ${folderName}`);
  for (const [name, content] of Object.entries(sourceFiles ?? {})) {
    if (!["index.html", "styles.css", "script.js"].includes(name)) continue;
    await putFile(`${folderName}/source/${name}`, content, `Publish ${folderName} ${name} source`);
  }

  return {
    repositoryUrl: `${repository.html_url}/tree/main/${folderName}`,
    pagesUrl: `https://${login}.github.io/${RANKED_REPO}/${folderName}/`,
    repoName: RANKED_REPO,
    folderName,
  };
}
