# Vendored third-party code

## `tailwindcss-3.4.17.cdn.txt`

Tailwind CSS's browser ("Play CDN") build, version 3.4.17, byte-for-byte as
served from `https://cdn.tailwindcss.com/3.4.17`.

- SHA-384 (base64): `igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K`
- It has a `.txt` extension so linters and bundlers treat it as data. It is
  only ever read as a string (`tailwind-source.ts`), served to the live
  preview at `/vendor/tailwindcss-3.4.17.js`, and committed next to each
  build a player publishes.
- To move to a newer release: download the new file, update the hash above,
  and change the version in `../tailwind.ts`, `../tailwind-source.ts` and the
  `app/vendor/` route folder name. Builds that are already published keep the
  copy they were published with.

Tailwind CSS is distributed under the MIT License:

```
MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
