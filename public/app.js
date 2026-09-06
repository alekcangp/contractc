// ContractCritic — frontend logic (vanilla JS)

(function () {
  "use strict";

  // ── DOM refs ────────────────────────────────────────────────
  var landing = document.getElementById("landing");
  var progressSection = document.getElementById("progress-section");
  var errorSection = document.getElementById("error-section");
  var reportSection = document.getElementById("report-section");
  var form = document.getElementById("investigate-form");
  var addressInput = document.getElementById("address-input");
  var investigateBtn = document.getElementById("investigate-btn");
  var inputError = document.getElementById("input-error");
  var progressList = document.getElementById("progress-list");
  var progressStatus = document.getElementById("progress-status");
  var errorMessage = document.getElementById("error-message");
  var errorRetry = document.getElementById("error-retry");
  var newInvestigation = document.getElementById("new-investigation");
  var reportAddress = document.getElementById("report-address");
  var riskBadge = document.getElementById("risk-badge");
  var evidenceSources = document.getElementById("evidence-sources");
  var reportBody = document.getElementById("report-body");

  // ── Progress steps ───────────────────────────────────────────
  var STEPS = [
    "Validating address",
    "Retrieving verified source",
    "Reading contract permissions",
    "Querying The Graph",
    "Preparing evidence",
    "AI investigation",
    "Building report",
  ];

  var LOADING_MESSAGES = [
    "Reading the fine print…",
    "Asking the contract uncomfortable questions…",
    "Checking who actually holds the keys…",
    "Comparing promises with implementation…",
    "Connecting the dots between code and chain…",
  ];

  var loadingTimer = null;
  var messageTimer = null;

  // ── Helpers ─────────────────────────────────────────────────
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function isValidAddress(addr) {
    return /^0x[a-fA-F0-9]{40}$/.test(addr);
  }

  function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function severityClass(sev) {
    var s = (sev || "").toLowerCase();
    if (s.indexOf("high") !== -1) return "high";
    if (s.indexOf("medium") !== -1 || s.indexOf("moderate") !== -1) return "medium";
    if (s.indexOf("low") !== -1) return "low";
    return "";
  }

  // ── Progress UI ─────────────────────────────────────────────
  function renderSteps() {
    progressList.innerHTML = STEPS.map(function (label, i) {
      return (
        '<li data-step="' + i + '">' +
        '<span class="progress-step-num">' + String(i + 1).padStart(2, "0") + "</span>" +
        '<span class="progress-step-icon"></span>' +
        '<span class="progress-step-label">' + escapeHtml(label) + "</span>" +
        "</li>"
      );
    }).join("");
  }

  function setStep(index, state) {
    var li = progressList.querySelector('[data-step="' + index + '"]');
    if (!li) return;
    li.classList.remove("active", "done");
    var icon = li.querySelector(".progress-step-icon");
    if (state === "active") {
      li.classList.add("active");
      icon.textContent = "";
    } else if (state === "done") {
      li.classList.add("done");
      icon.innerHTML = "&#10003;";
    }
  }

  function startProgressAnimation() {
    renderSteps();
    var msgIdx = 0;
    progressStatus.textContent = LOADING_MESSAGES[0];

    // Cycle loading messages
    messageTimer = setInterval(function () {
      msgIdx = (msgIdx + 1) % LOADING_MESSAGES.length;
      progressStatus.textContent = LOADING_MESSAGES[msgIdx];
    }, 3500);

    // Simulate sequential step progression while the request is in flight.
    // Steps 0–4 are shown as sequential progress. Steps 5–6 stay pending
    // until the response arrives — they are NOT falsely marked done.
    var step = 0;
    setStep(0, "active");
    loadingTimer = setInterval(function () {
      setStep(step, "done");
      step++;
      if (step <= 4) {
        setStep(step, "active");
      } else {
        clearInterval(loadingTimer);
        loadingTimer = null;
      }
    }, 1400);
  }

  function finishProgress() {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    if (messageTimer) { clearInterval(messageTimer); messageTimer = null; }
    for (var i = 0; i < STEPS.length; i++) {
      setStep(i, "done");
    }
    progressStatus.textContent = "Investigation complete.";
  }

  function failProgress() {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    if (messageTimer) { clearInterval(messageTimer); messageTimer = null; }
    progressStatus.textContent = "Investigation interrupted.";
  }

  // ── API call ────────────────────────────────────────────────
  async function investigate(address) {
    hide(landing);
    hide(errorSection);
    hide(reportSection);
    show(progressSection);
    startProgressAnimation();

    try {
      var resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address }),
      });

      var data = await resp.json();

      if (!resp.ok || !data.success) {
        failProgress();
        showError(data.error || "Something went wrong. Please try again.");
        return;
      }

      finishProgress();
      hide(progressSection);
      renderReport(data);
      show(reportSection);
    } catch (e) {
      failProgress();
      showError("The investigation failed. Please check your connection and try again.");
    }
  }

  // ── Error display ───────────────────────────────────────────
  function showError(msg) {
    hide(progressSection);
    errorMessage.textContent = msg;
    show(errorSection);
  }

  // ── Report rendering ────────────────────────────────────────
  function renderReport(data) {
    reportAddress.textContent = data.address;
    var report = data.report || {};

    // Risk badge
    var risk = report.riskLevel || "MODERATE CONCERN";
    riskBadge.textContent = risk;
    riskBadge.setAttribute("data-level", risk);

    // Evidence sources
    var sources = [];
    sources.push('<div class="evidence-source"><span class="check">&#10003;</span> Verified Contract Source</div>');
    sources.push('<div class="evidence-source"><span class="check">&#10003;</span> Contract ABI</div>');
    if (data.graph && data.graph.available) {
      sources.push('<div class="evidence-source"><span class="check">&#10003;</span> The Graph — live indexed evidence</div>');
    } else {
      sources.push('<div class="evidence-source"><span class="cross">&#10007;</span> The Graph — unavailable</div>');
    }
    sources.push('<div class="evidence-source"><span class="check">&#10003;</span> AI investigation</div>');
    evidenceSources.innerHTML = sources.join("");

    // Graph metadata banner (shows subgraph deployment ID + entities)
    var graphMetaHtml = "";
    if (data.graph && data.graph.available && data.graph.data) {
      var gd = data.graph.data;
      var subgraphId = gd.subgraph || "unknown";
      var entities = (gd.entities || []).join(", ") || "none";
      var activityCount = (gd.recentActivity || []).length;
      graphMetaHtml = '<div class="graph-meta">'
        + '<span class="graph-meta-label">SUBGRAPH</span> '
        + '<span class="graph-meta-value">' + escapeHtml(subgraphId) + '</span>'
        + ' <span class="graph-meta-sep">|</span> '
        + '<span class="graph-meta-label">ENTITIES</span> '
        + '<span class="graph-meta-value">' + escapeHtml(entities) + '</span>'
        + ' <span class="graph-meta-sep">|</span> '
        + '<span class="graph-meta-label">ACTIVITY RECORDS</span> '
        + '<span class="graph-meta-value">' + activityCount + '</span>'
        + '</div>';
    }

    // Build report blocks
    var html = "";

    // Executive Summary
    html += block("Executive Summary", "<p>" + escapeHtml(report.executiveSummary) + "</p>");

    // What it does
    if (report.whatItDoes) {
      html += block("What This Contract Actually Does", "<p>" + escapeHtml(report.whatItDoes) + "</p>");
    }

    // Who controls it
    if (report.whoControlsIt) {
      html += block("Who Controls It", "<p>" + escapeHtml(report.whoControlsIt) + "</p>");
    }

    // Decentralization
    if (report.decentralization) {
      html += block("Decentralization: Reality vs Claims", "<p>" + escapeHtml(report.decentralization) + "</p>");
    }

    // Technical mechanisms
    if (report.technicalMechanisms && report.technicalMechanisms.length > 0) {
      html += block("Important Technical Mechanisms", renderFindings(report.technicalMechanisms));
    }

    // What could go wrong
    if (report.whatCouldGoWrong && report.whatCouldGoWrong.length > 0) {
      html += block("What Could Go Wrong", renderFindings(report.whatCouldGoWrong));
    }

    // On-chain evidence (Graph)
    if (data.graph && data.graph.available) {
      var graphFindings = report.onChainEvidence || [];
      var graphHtml = graphMetaHtml || "";
      if (graphFindings.length > 0) {
        graphHtml += renderFindings(graphFindings);
      } else {
        graphHtml += '<div class="graph-unavailable">Live data was retrieved but the AI did not surface specific on-chain evidence findings.</div>';
      }
      html += block("On-Chain Evidence (The Graph)", graphHtml);
    } else {
      var reason = (data.graph && data.graph.reason) ? data.graph.reason : "No suitable Subgraph was available for this contract.";
      html += block("On-Chain Evidence (The Graph)", '<div class="graph-unavailable">' + escapeHtml(reason) + "</div>");
    }

    // Marketing vs reality
    if (report.marketingVsReality && report.marketingVsReality.length > 0) {
      html += block("Marketing vs Reality", renderFindings(report.marketingVsReality));
    } else {
      html += block("Marketing vs Reality", "<p>No project marketing claims were supplied for comparison.</p>");
    }

    // Positive signals
    if (report.positiveSignals && report.positiveSignals.length > 0) {
      html += block("Positive Signals", renderFindings(report.positiveSignals));
    }

    // Key findings
    if (report.keyFindings && report.keyFindings.length > 0) {
      html += block("Key Findings", renderFindings(report.keyFindings));
    }

    // Final verdict
    if (report.finalVerdict) {
      html += block("Final Verdict", "<p>" + escapeHtml(report.finalVerdict) + "</p>");
    }

    // Bottom line
    if (report.bottomLine) {
      html += '<div class="bottom-line"><h3>BOTTOM LINE</h3><p>"' + escapeHtml(report.bottomLine) + '"</p></div>';
    }

    reportBody.innerHTML = html;
  }

  function block(title, innerHtml) {
    return (
      '<div class="report-block">' +
      "<h3>" + escapeHtml(title) + "</h3>" +
      innerHtml +
      "</div>"
    );
  }

  function renderFindings(findings) {
    if (!Array.isArray(findings) || findings.length === 0) return "";
    return findings.map(function (f) {
      var type = (f.type || "FACT").toUpperCase();
      var typeClass = "tag-fact";
      if (type === "INTERPRETATION") typeClass = "tag-interpretation";
      else if (type === "UNKNOWN") typeClass = "tag-unknown";

      var sev = f.severity || "";
      var sevCls = severityClass(sev);

      var html = '<div class="finding">';
      html += '<div class="finding-header">';
      html += '<span class="finding-title">' + escapeHtml(f.title || "") + "</span>";
      html += '<div class="finding-tags">';
      html += '<span class="tag ' + typeClass + '">' + escapeHtml(type) + "</span>";
      if (sev) {
        html += '<span class="tag tag-severity ' + sevCls + '">' + escapeHtml(sev) + "</span>";
      }
      html += "</div>";
      html += "</div>";

      if (f.evidence) {
        html += '<div class="finding-evidence">' + escapeHtml(f.evidence) + "</div>";
      }
      if (f.analysis) {
        html += '<div class="finding-analysis">' + escapeHtml(f.analysis) + "</div>";
      }
      html += "</div>";
      return html;
    }).join("");
  }

  // ── Event handlers ──────────────────────────────────────────
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var addr = addressInput.value.trim();
    inputError.textContent = "";

    if (!addr) {
      inputError.textContent = "Enter a valid Ethereum contract address.";
      return;
    }
    if (!isValidAddress(addr)) {
      inputError.textContent = "Enter a valid Ethereum contract address.";
      return;
    }

    investigate(addr);
  });

  errorRetry.addEventListener("click", function () {
    hide(errorSection);
    show(landing);
    addressInput.focus();
  });

  newInvestigation.addEventListener("click", function () {
    hide(reportSection);
    show(landing);
    addressInput.value = "";
    addressInput.focus();
  });

  // Focus input on load
  addressInput.focus();
})();
