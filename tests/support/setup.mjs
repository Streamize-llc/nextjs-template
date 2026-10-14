// Registers the loader next to it. Used as `node --import ./tests/support/setup.mjs --test ...` (see the `test` script in package.json).
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
