"use strict";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function ansiToHtml(value) {
  const colors = new Map([
    [30, "black"], [31, "red"], [32, "green"], [33, "yellow"],
    [34, "blue"], [35, "magenta"], [36, "cyan"], [37, "white"],
    [90, "bright-black"], [91, "bright-red"], [92, "bright-green"],
    [93, "bright-yellow"], [94, "bright-blue"], [95, "bright-magenta"],
    [96, "bright-cyan"], [97, "bright-white"]
  ]);
  let classes = [];
  let html = "";
  const parts = String(value).split(/\u001b\[([0-9;]*)m/);
  for (let index = 0; index < parts.length; index++) {
    if (index % 2 === 0) {
      const text = escapeHtml(parts[index]);
      html += classes.length ? `<span class="${classes.join(" ")}">${text}</span>` : text;
      continue;
    }
    const codes = parts[index] ? parts[index].split(";").map(Number) : [0];
    for (const code of codes) {
      if (code === 0) {
        classes = [];
      } else if (code === 1) {
        classes = classes.filter(name => name !== "bold");
        classes.push("bold");
      } else if (colors.has(code)) {
        classes = classes.filter(name => !name.startsWith("fg-"));
        classes.push(`fg-${colors.get(code)}`);
      } else if (colors.has(code - 10)) {
        classes = classes.filter(name => !name.startsWith("bg-"));
        classes.push(`bg-${colors.get(code - 10)}`);
      }
    }
  }
  return html;
}

function parseLogErrors(content) {
  const errors = [];
  const lines = String(content).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const issue = line.match(/##vso\[task\.logissue\s+([^\]]*)\](.*)/i);
    if (issue && /(?:^|;)type=error(?:;|$)/i.test(issue[1])) {
      const properties = Object.fromEntries(issue[1].split(";").map(entry => {
        const separator = entry.indexOf("=");
        return separator < 0
          ? [entry.trim().toLowerCase(), ""]
          : [entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()];
      }));
      errors.push({
        message: issue[2] || "Pipeline error",
        file: properties.sourcepath,
        line: Number(properties.linenumber) || undefined,
        column: Number(properties.columnnumber) || undefined,
        logLine: index + 1
      });
      continue;
    }
    const errorText = line.replace(/^##\[error\]\s*/i, "");
    const compiler = errorText.match(/^(.+?)\((\d+)(?:,(\d+))?\):\s*error\b(.*)$/i);
    if (compiler) {
      errors.push({
        message: `error${compiler[4]}`,
        file: compiler[1],
        line: Number(compiler[2]),
        column: Number(compiler[3]) || undefined,
        logLine: index + 1
      });
      continue;
    }
    if (/##\[error\]/i.test(line)) {
      errors.push({
        message: line.replace(/^.*?##\[error\]\s*/i, "") || "Pipeline error",
        logLine: index + 1
      });
    }
  }
  return errors;
}

function mergeLogContent(current, tail) {
  const existing = String(current || "");
  const update = String(tail || "");
  if (!update) {
    return existing;
  }
  if (!existing || update.startsWith(existing)) {
    return update;
  }
  if (existing.startsWith(update)) {
    return existing;
  }

  const currentLines = existing.split(/\r?\n/);
  const tailLines = update.split(/\r?\n/);
  if (currentLines[currentLines.length - 1] === "") {
    currentLines.pop();
  }
  if (tailLines[tailLines.length - 1] === "") {
    tailLines.pop();
  }
  const maxOverlap = Math.min(currentLines.length, tailLines.length);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size--) {
    if (currentLines.slice(-size).every((line, index) => line === tailLines[index])) {
      overlap = size;
      break;
    }
  }
  if (!overlap) {
    return undefined;
  }

  const appended = tailLines.slice(overlap).join("\n");
  if (!appended) {
    return existing;
  }
  let merged = `${existing}${existing.endsWith("\n") ? "" : "\n"}${appended}`;
  if (update.endsWith("\n") && !merged.endsWith("\n")) {
    merged += "\n";
  }
  return merged;
}

function renderLogBody(content) {
  const groups = [];
  const output = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, index) => {
    const groupStart = line.match(/##\[group\](.*)/i);
    if (groupStart) {
      groups.push("</details>");
      output.push(`<details class="log-group" open><summary>${ansiToHtml(groupStart[1])}</summary>`);
      return;
    }
    if (/##\[endgroup\]/i.test(line)) {
      if (groups.length) {
        output.push(groups.pop());
      }
      return;
    }
    if (!line) {
      output.push(`<div class="log-line" id="log-line-${index + 1}">&nbsp;</div>`);
      return;
    }
    const error = /##\[error\]|type=error/i.test(line);
    const section = line.match(/##\[section\](.*)/i);
    const text = section ? section[1] : line;
    const timestamp = text.match(/^(\[?\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\]?)(\s*:?\s*)(.*)$/);
    const renderedText = timestamp
      ? `<span class="log-timestamp">${ansiToHtml(timestamp[1])}${escapeHtml(timestamp[2])}</span>${ansiToHtml(timestamp[3])}`
      : ansiToHtml(text);
    output.push(
      `<div class="log-line${error ? " error" : ""}" id="log-line-${index + 1}">` +
      `<span class="line-number">${index + 1}</span>${renderedText}</div>`
    );
  });
  while (groups.length) {
    output.push(groups.pop());
  }
  return output.join("\n");
}

function renderErrors(content) {
  return parseLogErrors(content).map(error => {
    const location = error.file
      ? `${error.file}${error.line ? `:${error.line}${error.column ? `:${error.column}` : ""}` : ""}`
      : `Log line ${error.logLine}`;
    return `<li><button class="error-link" data-file="${escapeHtml(error.file || "")}" ` +
      `data-line="${error.line || ""}" data-column="${error.column || ""}" ` +
      `data-log-line="${error.logLine}"><span>${escapeHtml(error.message)}</span>` +
      `<small>${escapeHtml(location)}</small></button></li>`;
  }).join("");
}

function renderLogHtml(content, {cspSource, nonce}) {
  const title = "Azure Pipelines Log";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 13px var(--vscode-editor-font-family, monospace); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
    header { position: sticky; top: 0; z-index: 2; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    h1 { margin: 0 10px 0 0; font: 600 14px var(--vscode-font-family); }
    #state { color: var(--vscode-descriptionForeground); }
    #search { width: min(28em, 45vw); padding: 4px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
    button, label { color: var(--vscode-foreground); font: inherit; }
    .toolbar button { border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); padding: 3px 8px; background: var(--vscode-button-secondaryBackground); cursor: pointer; }
    .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #match-count { min-width: 4em; color: var(--vscode-descriptionForeground); }
    .timestamps-hidden .log-timestamp { display: none; }
    #errors { margin: 0; padding: 0 16px; }
    #errors:empty { display: none; }
    #errors li { list-style: none; border-bottom: 1px solid var(--vscode-panel-border); }
    .error-link { display: flex; width: 100%; gap: 16px; justify-content: space-between; padding: 8px 0; border: 0; text-align: left; color: var(--vscode-errorForeground); background: transparent; cursor: pointer; }
    .error-link small { color: var(--vscode-descriptionForeground); }
    #log-content { padding: 12px 0 30px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .log-line { min-height: 1.5em; padding: 0 16px 0 0; }
    .line-number { display: inline-block; width: 5.2em; padding-right: 1em; color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
    .log-line.error { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 9%, transparent); }
    .log-line.search-match { background: color-mix(in srgb, var(--vscode-editor-findMatchBackground) 55%, transparent); }
    .log-line.search-current { outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder)); }
    .log-timestamp { color: var(--vscode-descriptionForeground); }
    .log-group { margin: 4px 16px; border-left: 1px solid var(--vscode-panel-border); }
    .log-group summary { padding: 4px 8px; color: var(--vscode-textLink-foreground); cursor: pointer; }
    .bold { font-weight: 700; }
    .fg-black { color: #000; } .fg-red { color: #cd3131; } .fg-green { color: #0dbc79; } .fg-yellow { color: #e5e510; }
    .fg-blue { color: #2472c8; } .fg-magenta { color: #bc3fbc; } .fg-cyan { color: #11a8cd; } .fg-white { color: #e5e5e5; }
    .fg-bright-black { color: #666; } .fg-bright-red { color: #f14c4c; } .fg-bright-green { color: #23d18b; } .fg-bright-yellow { color: #f5f543; }
    .fg-bright-blue { color: #3b8eea; } .fg-bright-magenta { color: #d670d6; } .fg-bright-cyan { color: #29b8db; } .fg-bright-white { color: #fff; }
    .bg-black { background: #000; } .bg-red { background: #cd3131; } .bg-green { background: #0dbc79; } .bg-yellow { background: #e5e510; }
    .bg-blue { background: #2472c8; } .bg-magenta { background: #bc3fbc; } .bg-cyan { background: #11a8cd; } .bg-white { background: #e5e5e5; }
  </style>
</head>
<body>
  <header>
    <div class="toolbar">
      <h1>${title}</h1>
      <input id="search" type="search" placeholder="Find in log" aria-label="Find in log">
      <button id="previous" type="button" aria-label="Previous match">Previous</button>
      <button id="next" type="button" aria-label="Next match">Next</button>
      <span id="match-count" aria-live="polite"></span>
      <label><input id="show-timestamps" type="checkbox" checked> Timestamps</label>
      <span id="state">Loading</span>
    </div>
  </header>
  <ul id="errors">${renderErrors(content)}</ul>
  <main id="log-content">${renderLogBody(content)}</main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const errors = document.getElementById("errors");
    const log = document.getElementById("log-content");
    const state = document.getElementById("state");
    const search = document.getElementById("search");
    const matchCount = document.getElementById("match-count");
    const showTimestamps = document.getElementById("show-timestamps");
    let matches = [];
    let currentMatch = -1;
    const findMatches = (fromCurrent = false, direction = 1, preferredId) => {
      const query = search.value.trim().toLocaleLowerCase();
      matches = query
        ? Array.from(log.querySelectorAll(".log-line")).filter(line => {
            const numberLength = line.querySelector(".line-number")?.textContent.length || 0;
            return line.textContent.slice(numberLength).toLocaleLowerCase().includes(query);
          })
        : [];
      for (const line of log.querySelectorAll(".log-line")) {
        line.classList.remove("search-match", "search-current");
      }
      matches.forEach(line => line.classList.add("search-match"));
      if (!matches.length) {
        currentMatch = -1;
        matchCount.textContent = query ? "No matches" : "";
        return;
      }
      if (preferredId) {
        const preferredIndex = matches.findIndex(line => line.id === preferredId);
        currentMatch = preferredIndex >= 0 ? preferredIndex : 0;
      } else if (!fromCurrent || currentMatch < 0) {
        currentMatch = direction > 0 ? 0 : matches.length - 1;
      } else {
        currentMatch = (currentMatch + direction + matches.length) % matches.length;
      }
      matches[currentMatch].classList.add("search-current");
      matches[currentMatch].scrollIntoView({block: "center"});
      matchCount.textContent = (currentMatch + 1) + " of " + matches.length;
    };
    search.addEventListener("input", () => findMatches());
    document.getElementById("previous").addEventListener("click", () => findMatches(true, -1));
    document.getElementById("next").addEventListener("click", () => findMatches(true, 1));
    showTimestamps.addEventListener("change", () => {
      document.body.classList.toggle("timestamps-hidden", !showTimestamps.checked);
    });
    document.addEventListener("click", event => {
      const button = event.target.closest(".error-link");
      if (!button) return;
      if (!button.dataset.file) {
        document.getElementById("log-line-" + button.dataset.logLine)?.scrollIntoView({block: "center"});
      }
      vscode.postMessage({
        type: "jump",
        file: button.dataset.file,
        line: Number(button.dataset.line) || undefined,
        column: Number(button.dataset.column) || undefined,
        logLine: Number(button.dataset.logLine)
      });
    });
    window.addEventListener("message", event => {
      if (event.data.type !== "update") return;
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      const collapsed = Array.from(log.querySelectorAll("details")).map(item => item.open);
      const currentMatchId = log.querySelector(".search-current")?.id;
      log.innerHTML = event.data.logHtml;
      document.body.classList.toggle("timestamps-hidden", !showTimestamps.checked);
      Array.from(log.querySelectorAll("details")).forEach((item, index) => {
        item.open = collapsed[index] === undefined ? true : collapsed[index];
      });
      errors.innerHTML = event.data.errorsHtml;
      if (search.value) findMatches(false, 1, currentMatchId);
      state.textContent = event.data.active ? "Live - updates every few seconds" : "Completed";
      if (nearBottom) log.scrollTop = log.scrollHeight;
    });
    state.textContent = ${JSON.stringify(stateText(content))};
  </script>
</body>
</html>`;
}

function stateText(content) {
  return String(content || "").length ? "Loaded" : "Waiting for output";
}

module.exports = {
  ansiToHtml,
  mergeLogContent,
  parseLogErrors,
  renderLogBody,
  renderErrors,
  renderLogHtml
};
