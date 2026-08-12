const githubHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

export function githubAuthorizationUrl(
  state: string,
  challenge: string,
  redirectUri: string,
) {
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

export async function exchangeGitHubCode(
  code: string,
  verifier: string,
  redirectUri: string,
) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required.");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: process.env.GITHUB_REDIRECT_URI ?? redirectUri,
    }),
  });
  const token = (await response.json()) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !token.access_token)
    throw new Error(token.error_description ?? "GitHub token exchange failed.");
  const userResponse = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token.access_token),
  });
  if (!userResponse.ok)
    throw new Error(`GitHub profile request failed (${userResponse.status}).`);
  const user = (await userResponse.json()) as {
    login: string;
    avatar_url?: string;
  };
  return {
    accessToken: token.access_token,
    login: user.login,
    avatarUrl: user.avatar_url ?? null,
  };
}

async function githubRequest<T>(
  token: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(token), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 422 && url.endsWith("/user/repos"))
      throw new Error(
        "That repository name is already in use on your GitHub account. Choose another name.",
      );
    throw new Error(
      `GitHub request failed (${response.status}): ${detail.slice(0, 280)}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const RANKED_REPO = "hackclubranked";
const isNotFound = (error: unknown) =>
  error instanceof Error && error.message.includes("(404)");

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
    return await githubRequest<{ html_url: string }>(
      token,
      `https://api.github.com/repos/${login}/${RANKED_REPO}`,
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const repository = await githubRequest<{ html_url: string }>(
    token,
    "https://api.github.com/user/repos",
    {
      method: "POST",
      body: JSON.stringify({
        name: RANKED_REPO,
        description:
          "Hack Club Ranked is a program run by [Hack Club](https://hackclub.com) where teenagers compete and collaborate to speedrun making websites according to a theme. Whoever has the best site at the end wins, and the more matches you win the higher your Ranking. The more matches you play and more hours you code, you can buy cool prizes in the shop like drawing tablets, iPads, hoodies, headphones, and more!",
        homepage: `https://${login}.github.io/${RANKED_REPO}/`,
        private: false,
        has_issues: true,
        auto_init: true,
      }),
    },
  );
  await githubRequest(token, repoContentsPath(login, ".nojekyll"), {
    method: "PUT",
    body: JSON.stringify({
      message: "Configure GitHub Pages",
      content: "",
      branch: "main",
    }),
  });
  try {
    await githubRequest(
      token,
      `https://api.github.com/repos/${login}/${RANKED_REPO}/pages`,
      {
        method: "POST",
        body: JSON.stringify({ source: { branch: "main", path: "/" } }),
      },
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("409"))
      throw error;
  }
  return repository;
}

const RESERVED_FOLDER_NAMES = ["index.html", "readme.md", ".nojekyll"];
export const PUBLISHABLE_FILE_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(html|css|js)$/;

export async function publishWebsite(
  token: string,
  login: string,
  requestedName: string,
  pages: Record<string, string>,
  sourceFiles?: Record<string, string>,
  description?: string,
) {
  const folderName = requestedName.trim();
  if (
    !/^[A-Za-z0-9._-]{1,100}$/.test(folderName) ||
    folderName === "." ||
    folderName === ".."
  ) {
    throw new Error(
      "Build names may only use letters, numbers, periods, underscores, and hyphens.",
    );
  }
  if (RESERVED_FOLDER_NAMES.includes(folderName.toLowerCase())) {
    throw new Error(`"${folderName}" is reserved. Choose another build name.`);
  }
  if (!pages["index.html"]) {
    throw new Error("An index.html page is required.");
  }
  const repository = await ensureRankedRepo(token, login);
  if (await pathExists(token, login, folderName)) {
    throw new Error(
      `"${folderName}" is already used in your ${RANKED_REPO} repo. Choose another name.`,
    );
  }

  const putFile = (path: string, content: string, message: string) =>
    githubRequest(token, repoContentsPath(login, path), {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: "main",
      }),
    });

  for (const [name, content] of Object.entries(pages)) {
    if (!PUBLISHABLE_FILE_NAME.test(name) || !name.endsWith(".html")) continue;
    await putFile(
      `${folderName}/${name}`,
      content,
      `Publish ${folderName} ${name}`,
    );
  }
  const trimmedDescription = description?.trim();
  await putFile(
    `${folderName}/README.md`,
    `# ${folderName}\n\n${trimmedDescription ? `${trimmedDescription}\n\n` : ""}This website was built live on [Hack Club Ranked](https://ranked.hackclub.com).\n`,
    `Add README for ${folderName}`,
  );
  // .html source is skipped here — the bundled version above already covers
  // it, so keeping the raw copy too would just duplicate every page. .css/.js
  // still need their unbundled originals (the pages above only carry them
  // inlined), sorted into styles/ and scripts/ instead of one flat "source".
  for (const [name, content] of Object.entries(sourceFiles ?? {})) {
    if (!PUBLISHABLE_FILE_NAME.test(name) || name.endsWith(".html")) continue;
    const subfolder = name.endsWith(".css") ? "styles" : "scripts";
    await putFile(
      `${folderName}/${subfolder}/${name}`,
      content,
      `Publish ${folderName} ${name} source`,
    );
  }

  return {
    repositoryUrl: `${repository.html_url}/tree/main/${folderName}`,
    pagesUrl: `https://${login}.github.io/${RANKED_REPO}/${folderName}/`,
    repoName: RANKED_REPO,
    folderName,
  };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

export type DirectoryBuild = {
  folderName: string;
  theme: string;
  publishedAt: string;
};

function renderDirectoryIndex(login: string, builds: DirectoryBuild[]) {
  const items = builds
    .map(
      (build) => `
      <li>
        <a href="./${encodeURIComponent(build.folderName)}/">${escapeHtml(build.folderName)}</a>
        <span>${escapeHtml(build.theme)} · ${escapeHtml(new Date(build.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }))}</span>
      </li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(login)}'s Ranked builds</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: #fff8cf; color: #20201f; padding: 48px 24px; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 6px; }
  p.sub { color: #5c574b; margin: 0 0 32px; font-size: 14px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  li { border: 2px solid #20201f; border-radius: 14px; padding: 16px; background: #fffdf0; box-shadow: 4px 4px 0 #20201f; }
  li a { text-decoration: none; color: #20201f; font-weight: 700; font-size: 15px; display: block; margin-bottom: 6px; word-break: break-word; }
  li span { display: block; font-size: 11px; color: #5c574b; text-transform: uppercase; letter-spacing: .08em; }
  footer { margin-top: 40px; font-size: 11px; color: #5c574b; }
  footer a { color: #497cbf; }
  @media (prefers-color-scheme: dark) {
    body { background: #171613; color: #f5f3e9; }
    li { background: #20201f; border-color: #f5f3e9; box-shadow: 4px 4px 0 #f5f3e9; }
    li a { color: #f5f3e9; }
  }
</style>
</head>
<body>
<main>
  <h1>@${escapeHtml(login)}'s Ranked builds</h1>
  <p class="sub">${builds.length} site${builds.length === 1 ? "" : "s"} built live on Hack Club Ranked.</p>
  <ul>${items}
  </ul>
  <footer>Built with <a href="https://ranked.hackclub.com">Hack Club Ranked</a></footer>
</main>
</body>
</html>
`;
}

export async function updateDirectoryIndex(
  token: string,
  login: string,
  builds: DirectoryBuild[],
) {
  let sha: string | undefined;
  try {
    const existing = await githubRequest<{ sha: string }>(
      token,
      repoContentsPath(login, "index.html"),
    );
    sha = existing.sha;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const html = renderDirectoryIndex(login, builds);
  await githubRequest(token, repoContentsPath(login, "index.html"), {
    method: "PUT",
    body: JSON.stringify({
      message: "Update builds directory",
      content: Buffer.from(html, "utf8").toString("base64"),
      branch: "main",
      ...(sha ? { sha } : {}),
    }),
  });
}
