// htm bound to Preact's h. Every component imports `html` from here so the
// tagged-template dialect is set up in exactly one place (there is no JSX
// compile step in this project -- see index.html's importmap).
import { h } from "preact";
import htm from "htm";

export const html = htm.bind(h);
