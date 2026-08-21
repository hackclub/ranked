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
    if (response.status === 422 && url.endsWith("/user/repos")) {
      // 422 on repo creation covers *any* validation failure GitHub rejects
      // the request for — a name collision is only one of them (account
      // restrictions, an unverified email, a malformed field, etc. all land
      // here too). Only show the "name already in use" message when GitHub's
      // own error body actually says so; otherwise surface its real reason
      // instead of a misleading one, since previously every 422 got the same
      // "name already in use" text even when there was no conflicting repo.
      let nameTaken = false;
      let githubMessage: string | undefined;
      try {
        const parsed = JSON.parse(detail) as {
          message?: string;
          errors?: Array<{ field?: string; message?: string }>;
        };
        githubMessage = parsed.message;
        nameTaken = Boolean(
          parsed.errors?.some(
            (entry) =>
              entry.field === "name" ||
              /name already exists/i.test(entry.message ?? ""),
          ),
        );
      } catch {}
      if (nameTaken) {
        throw new Error(
          "That repository name is already in use on your GitHub account. Choose another name.",
        );
      }
      throw new Error(
        `GitHub couldn't create your hackclubranked repo: ${githubMessage ?? detail.slice(0, 280)}`,
      );
    }
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

const FAVICON_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M22 19.2727C22 20.779 20.779 22 19.2727 22H14.7273C13.221 22 12 20.779 12 19.2727V12H19.2727C20.779 12 22 13.221 22 14.7273V19.2727Z" fill="#68C4FF"/>' +
  '<path d="M20 2C21.1046 2 22 2.89543 22 4V7C22 8.10457 21.1046 9 20 9H17C15.8954 9 15 8.10457 15 7V4C15 2.89543 15.8954 2 17 2H20Z" fill="#0C79D8"/>' +
  '<path d="M7 15C8.10457 15 9 15.8954 9 17V20C9 21.1046 8.10457 22 7 22H4C2.89543 22 2 21.1046 2 20V17C2 15.8954 2.89543 15 4 15H7Z" fill="#0C79D8"/>' +
  '<path d="M12 12H4.72727C3.22104 12 2 10.779 2 9.27273V4.72727C2 3.22104 3.22104 2 4.72727 2H9.27273C10.779 2 12 3.22104 12 4.72727V12Z" fill="#2E9EFF"/>' +
  "</svg>";

const EXTERNAL_ICON =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';
const CLOCK_ICON =
  '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>';

function renderDirectoryIndex(login: string, builds: DirectoryBuild[]) {
  const buildCount = builds.length;
  const cards = builds
    .map((build) => {
      const date = escapeHtml(
        new Date(build.publishedAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
      );
      return `
        <li>
          <a class="build-card" href="./${encodeURIComponent(build.folderName)}/">
            <span class="build-card-tag">${escapeHtml(build.theme)}</span>
            <strong class="build-card-name">${escapeHtml(build.folderName)}</strong>
            <span class="build-card-meta">${CLOCK_ICON}${date}</span>
            <span class="build-card-cta">open build ${EXTERNAL_ICON}</span>
          </a>
        </li>`;
    })
    .join("");

  const gallery = buildCount
    ? `<ul class="gallery-grid">${cards}
      </ul>`
    : `<div class="empty-state">
        <p>No builds published yet — every match ${escapeHtml(login)} finishes on Hack Club Ranked shows up here as a new card.</p>
        <a class="pill-button" href="https://ranked.hackclub.com">queue up a match ${EXTERNAL_ICON}</a>
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(login)}'s Hack Club Ranked builds</title>
<meta name="description" content="Websites ${escapeHtml(login)} built live on Hack Club Ranked.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..900&family=Geist+Mono:wght@400..900&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --cream: #fff8cf;
    --ink: #20201f;
    --muted: #5c574b;
    --pink: #d891d9;
    --blue: #497cbf;
    --blue-strong: #2f5a8c;
    --green: #ccd96c;
    --orange: #d99f6c;
    --paper: #fffdf0;
    --line: #2c2b29;
    --blob: 255px 20px 225px 20px / 20px 225px 15px 255px;
    --font-sans: "Geist", ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    --font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-width: 320px;
    color: var(--ink);
    font-family: var(--font-sans);
    background-color: var(--cream);
    background-image: radial-gradient(#c7b65c45 0.7px, transparent 0.7px);
    background-size: 17px 17px;
  }
  a:focus-visible, button:focus-visible {
    outline: 3px solid var(--blue);
    outline-offset: 3px;
  }
  .page { max-width: 1180px; margin: 0 auto; padding: 28px 24px 64px; }
  .site-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 14px;
    padding-bottom: 30px;
  }
  .logo {
    display: inline-flex;
    align-items: flex-start;
    gap: 8px;
    text-decoration: none;
    color: var(--ink);
    transform: rotate(-1deg);
  }
  .logo span {
    font-size: 30px;
    line-height: 0.9;
    font-weight: 950;
    letter-spacing: -0.08em;
    transform: scaleX(0.92);
  }
  .logo em {
    font-style: normal;
    font-size: 11px;
    font-weight: 900;
    margin-top: 5px;
    letter-spacing: -0.07em;
  }
  .pill-button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 2px solid var(--ink);
    background: var(--paper);
    box-shadow: 3px 3px 0 var(--ink);
    padding: 10px 16px;
    font: 650 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink);
    text-decoration: none;
    border-radius: var(--blob);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .pill-button:hover { background: var(--green); transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--ink); }
  .pill-button:active { transform: translate(3px, 3px); box-shadow: none; }
  .page-head { max-width: 640px; margin: 8px auto 40px; text-align: center; }
  .build-count-sticker {
    display: inline-block;
    margin-bottom: 14px;
    border: 2px solid var(--ink);
    background: var(--orange);
    padding: 6px 14px;
    font: 800 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    box-shadow: 3px 3px 0 var(--ink);
    border-radius: var(--blob);
    transform: rotate(-4deg);
  }
  .page-head h1 {
    margin: 4px 0 12px;
    font-size: clamp(34px, 5vw, 58px);
    letter-spacing: -0.065em;
    line-height: 0.95;
  }
  .page-head p {
    margin: 0 auto;
    max-width: 480px;
    font: 450 13px/1.6 var(--font-sans);
    color: var(--muted);
  }
  .gallery-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: clamp(18px, 3vw, 26px);
  }
  .gallery-grid li { display: flex; min-width: 0; }
  .build-card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 150px;
    border: 2px solid var(--line);
    background: var(--paper);
    box-shadow: 5px 6px 0 #24231f;
    padding: 18px 18px 16px;
    border-radius: var(--blob);
    text-decoration: none;
    color: var(--ink);
    --tilt: -0.5deg;
    transform: rotate(var(--tilt));
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .gallery-grid li:nth-child(even) .build-card { --tilt: 0.45deg; }
  .build-card:hover { transform: translate(3px, 3px) rotate(var(--tilt)); box-shadow: 2px 3px 0 #24231f; }
  .build-card:active { transform: translate(5px, 5px) rotate(var(--tilt)); box-shadow: none; }
  .build-card-tag {
    display: inline-flex;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1.5px solid var(--ink);
    background: var(--cream);
    color: var(--ink);
    padding: 3px 10px;
    font: 700 11px var(--font-mono);
    letter-spacing: -0.01em;
    border-radius: var(--blob);
  }
  .gallery-grid li:nth-child(4n+1) .build-card-tag { background: var(--green); }
  .gallery-grid li:nth-child(4n+2) .build-card-tag { background: var(--orange); }
  .gallery-grid li:nth-child(4n+3) .build-card-tag { background: var(--pink); }
  .gallery-grid li:nth-child(4n) .build-card-tag { background: var(--blue-strong); color: var(--cream); border-color: var(--blue-strong); }
  .build-card-name {
    margin: 4px 0 0;
    font: 700 17px var(--font-mono);
    letter-spacing: -0.01em;
    line-height: 1.25;
    word-break: break-word;
  }
  .build-card-meta {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font: 600 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .build-card-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding-top: 10px;
    border-top: 1px dashed #00000022;
    font: 650 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--blue-strong);
  }
  .build-card:hover .build-card-cta { color: var(--ink); }
  .empty-state {
    max-width: 480px;
    margin: 20px auto 0;
    text-align: center;
    border: 2px dashed var(--ink);
    background: var(--paper);
    padding: 36px 28px;
    border-radius: var(--blob);
  }
  .empty-state p {
    margin: 0 0 20px;
    font: 500 12px/1.6 var(--font-mono);
    color: var(--muted);
  }
  .site-footer {
    margin-top: 56px;
    padding-top: 20px;
    border-top: 1px dashed #00000022;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 10px;
    font: 650 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .site-footer a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--blue);
    text-decoration: none;
  }
  .site-footer a:hover { color: var(--blue-strong); text-decoration: underline; }
  @media (max-width: 760px) {
    .gallery-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  }
  @media (max-width: 480px) {
    .site-header { flex-direction: column; align-items: center; text-align: center; }
    .gallery-grid { grid-template-columns: 1fr; }
    .site-footer { flex-direction: column; align-items: center; text-align: center; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
</head>
<body>
<div class="page">
  <header class="site-header">
    <a class="logo" href="https://ranked.hackclub.com" aria-label="Hack Club Ranked home">
      <span>HACK CLUB</span><em>ranked</em>
    </a>
    <a class="pill-button" href="https://ranked.hackclub.com">play a match ${EXTERNAL_ICON}</a>
  </header>
  <main>
    <div class="page-head">
      <span class="build-count-sticker">${buildCount} build${buildCount === 1 ? "" : "s"}</span>
      <h1>@${escapeHtml(login)}</h1>
      <p>Every site ${escapeHtml(login)} has built live on Hack Club Ranked.</p>
    </div>
    ${gallery}
  </main>
  <footer class="site-footer">
    <span>Built live on Hack Club Ranked</span>
    <a href="https://github.com/${escapeHtml(login)}/hackclubranked">view source on GitHub ${EXTERNAL_ICON}</a>
  </footer>
</div>
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
