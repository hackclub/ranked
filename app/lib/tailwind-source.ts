// Server-only: importing this pulls the whole ~400 KB script into the bundle.
import source from "./vendor/tailwindcss-3.4.17.cdn.txt?raw";

export const TAILWIND_SOURCE: string = source;
