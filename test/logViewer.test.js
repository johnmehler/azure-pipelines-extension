"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ansiToHtml,
  mergeLogContent,
  parseLogErrors,
  renderLogBody,
  renderLogHtml
} = require("../src/logViewer");

test("ANSI sequences are converted to safe colored spans", () => {
  assert.equal(
    ansiToHtml("\u001b[31m<failed>\u001b[0m"),
    '<span class="fg-red">&lt;failed&gt;</span>'
  );
});

test("Azure log group markers render as collapsible sections", () => {
  const html = renderLogBody("##[group]Compile\ncompiler output\n##[endgroup]");
  assert.match(html, /<details class="log-group" open>/);
  assert.match(html, /<summary>Compile<\/summary>/);
  assert.match(html, /compiler output/);
  assert.doesNotMatch(html, /##\[endgroup\]/);
});

test("log viewer renders timestamps and provides find controls", () => {
  const body = renderLogBody("2026-11-20T10:30:00.123Z: build started");
  assert.match(body, /class="log-timestamp">2026-11-20T10:30:00\.123Z: /);
  const html = renderLogHtml("build started", {cspSource: "vscode-webview:", nonce: "test"});
  assert.match(html, /placeholder="Find in log"/);
  assert.match(html, /id="show-timestamps"/);
  assert.match(html, /id="next"/);
});

test("log tails merge overlapping lines without duplicating output", () => {
  assert.equal(mergeLogContent("one\ntwo\n", "two\nthree\n"), "one\ntwo\nthree\n");
  assert.equal(mergeLogContent("one\ntwo", "two\nthree"), "one\ntwo\nthree");
  assert.equal(mergeLogContent("one\ntwo", "unrelated"), undefined);
});

test("Azure issue and compiler errors include source locations", () => {
  const errors = parseLogErrors([
    "##vso[task.logissue type=error;sourcepath=src/app.ts;linenumber=7;columnnumber=3]failed",
    "C:\\repo\\app.cs(12,4): error CS1000: invalid"
  ].join("\n"));

  assert.deepEqual(errors, [
    {message: "failed", file: "src/app.ts", line: 7, column: 3, logLine: 1},
    {message: "error CS1000: invalid", file: "C:\\repo\\app.cs", line: 12, column: 4, logLine: 2}
  ]);
});

test("webview log markup escapes untrusted log content", () => {
  const html = renderLogHtml("<script>bad()</script>", {cspSource: "vscode-webview:", nonce: "test"});
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
});
