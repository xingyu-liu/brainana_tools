import fs from "node:fs";
const source = fs.readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
const css = fs.readFileSync(
  new URL("../src/style.css", import.meta.url),
  "utf8",
);
const required = [
  'id="functional-surface-brightness"',
  'id="somatotopy-surface-brightness"',
  'id="functional-surface-order"',
  'class="function-report-panel"',
  'class="visual-field-panel"',
  "charm: { visible: false",
  "channel + (255 - channel)",
  "functionalSurfaceOrder === 'somatotopy'",
];
for (const text of required) {
  if (!source.includes(text))
    throw new Error(`Missing expected source feature: ${text}`);
}
if (!css.includes(".visual-field-panel .visual-field-stage"))
  throw new Error("Missing independent visual-field sizing");
if (
  !css.includes(
    ".info-panel > .visual-field-panel { display: flex !important; }",
  )
)
  throw new Error("Small-window visual-field panel can still be hidden");
console.log("v1.2.15 UI/state checks passed");
