import React, { useRef, useState, useEffect, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import workerSrc from "pdfjs-dist/build/pdf.worker.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

/*
  Final App.js
  - Renders PDF pages (canvas + textLayer) inside React
  - Right-side analysis panel with clickable citations [1][2][3]
  - Pixel-accurate highlights on click
*/

export default function App() {
  // Ensure PDF file is placed in public/
  const pdfPath = "/Maersk-Q2-2025-Interim-Report.pdf";

  const containerRef = useRef(null);
  const pageRefs = useRef({}); // pageNumber -> { pageContainer, canvas, textLayer }
  const hideTimeoutRef = useRef(null);

  const [numPages, setNumPages] = useState(0);
  const [activeRef, setActiveRef] = useState(null);
  const [highlightActive, setHighlightActive] = useState(false);
  const [pinned, setPinned] = useState(false);

  // Static boxes (kept for overlay fallback if needed)
  const defaultBoxes = {
    p3: { topPct: 0.32, leftPct: 0.29, widthPct: 0.56, heightPx: 50, borderRadius: 6, label: "[1]" },
    p5: { topPct: 0.39, leftPct: 0.29, widthPct: 0.56, heightPx: 50, borderRadius: 6, label: "[2]" },
    p15: { topPct: 0.47, leftPct: 0.29, widthPct: 0.56, heightPx: 50, borderRadius: 6, label: "[3]" },
  };
  const [highlightBoxes] = useState(defaultBoxes);

  const BADGES = {
    p3: { excerpt: "EBITDA of USD 2.3 bn (USD 2.1 bn) driven by volume & operational improvements. (Page 3)" },
    p5: { excerpt: "EBITDA increased to USD 2.3 bn — revenue growth and cost control across segments. (Page 5)" },
    p15: { excerpt: "Gain on sale of non-current assets, net: 25 (208) — reported below EBITDA (Page 15)." },
  };

  // clear any existing DOM highlights
  const clearAllHighlights = useCallback(() => {
    try {
      const c = containerRef.current;
      if (!c) return;
      c.querySelectorAll(".pdf-perfect-highlight").forEach((n) => n.remove());
    } catch (e) {
      // ignore
    }
  }, []);

  // Render single page into canvas + textLayer
  const renderPage = useCallback(async (pdf, pageNumber) => {
    try {
      const page = await pdf.getPage(pageNumber);
      const scale = 1.2; // adjust for crispness
      const viewport = page.getViewport({ scale });

      // create or reuse page container
      let pageContainer = pageRefs.current[pageNumber]?.pageContainer;
      if (!pageContainer) {
        pageContainer = document.createElement("div");
        pageContainer.className = "pdf-page";
        pageContainer.style.position = "relative";
        pageContainer.style.margin = "10px auto";
        pageContainer.style.width = `${Math.round(viewport.width)}px`;
        pageContainer.style.height = `${Math.round(viewport.height)}px`;
        if (containerRef.current) containerRef.current.appendChild(pageContainer);
        pageRefs.current[pageNumber] = { pageContainer, canvas: null, textLayer: null };
      } else {
        pageContainer.style.width = `${Math.round(viewport.width)}px`;
        pageContainer.style.height = `${Math.round(viewport.height)}px`;
      }

      // canvas
      let canvas = pageRefs.current[pageNumber].canvas;
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.style.display = "block";
        pageContainer.appendChild(canvas);
        pageRefs.current[pageNumber].canvas = canvas;
      }
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;

      // render page
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

      // text layer (remove old)
      if (pageRefs.current[pageNumber].textLayer) {
        pageRefs.current[pageNumber].textLayer.remove();
      }

      const textLayerDiv = document.createElement("div");
      textLayerDiv.className = "textLayer";
      textLayerDiv.style.position = "absolute";
      textLayerDiv.style.left = "0";
      textLayerDiv.style.top = "0";
      textLayerDiv.style.width = `${Math.round(viewport.width)}px`;
      textLayerDiv.style.height = `${Math.round(viewport.height)}px`;
      textLayerDiv.style.pointerEvents = "auto"; // allow detection

      pageContainer.appendChild(textLayerDiv);
      pageRefs.current[pageNumber].textLayer = textLayerDiv;

      const textContent = await page.getTextContent();
      const frag = document.createDocumentFragment();

      for (let i = 0; i < textContent.items.length; i++) {
        const item = textContent.items[i];
        const str = item.str || "";
        if (!str.trim()) continue;

        const span = document.createElement("span");
        span.className = "textLayerItem";
        span.textContent = str;

        // transform and font height approx
        const tx = item.transform;
        const fontHeight = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) * viewport.scale;

        const [x, y] = viewport.convertToViewportPoint(tx[4], tx[5]);
        span.style.position = "absolute";
        span.style.left = `${Math.round(x)}px`;
        span.style.top = `${Math.round(y - fontHeight)}px`;
        span.style.fontSize = `${Math.round(fontHeight)}px`;
        span.style.lineHeight = `${Math.round(fontHeight)}px`;
        span.style.whiteSpace = "pre";
        // hide underlying text (we draw highlights over it)
        span.style.color = "transparent";
        frag.appendChild(span);
      }

      textLayerDiv.appendChild(frag);

      // measure spans widths
      const measureCanvas = document.createElement("canvas");
      const mctx = measureCanvas.getContext("2d");
      const spans = Array.from(textLayerDiv.querySelectorAll(".textLayerItem"));
      spans.forEach((s) => {
        const fs = window.getComputedStyle(s).fontSize || "12px";
        mctx.font = `${fs} Arial, sans-serif`;
        const w = mctx.measureText(s.textContent).width;
        s.style.width = `${Math.ceil(w)}px`;
      });
    } catch (err) {
      // console.error("renderPage err", err);
    }
  }, []);

  // Load PDF and render pages
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loadingTask = pdfjsLib.getDocument(pdfPath);
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        setNumPages(pdf.numPages);

        // clear container
        if (containerRef.current) containerRef.current.innerHTML = "";
        pageRefs.current = {};

        // render pages sequentially
        for (let p = 1; p <= pdf.numPages; p++) {
          // eslint-disable-next-line no-await-in-loop
          await renderPage(pdf, p);
        }
      } catch (e) {
        // console.error(e);
      }
    })();

    return () => {
      cancelled = true;
      // cleanup
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
  }, [pdfPath, renderPage]);

  // Highlight algorithm: finds matching spans and draws highlight div(s)
  const highlightText = useCallback(
    (pageNumber, searchText) => {
      clearAllHighlights();
      const pageObj = pageRefs.current[pageNumber];
      if (!pageObj || !pageObj.textLayer) return false;
      const { pageContainer, textLayer } = pageObj;

      const q = (searchText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!q) return false;

      const spans = Array.from(textLayer.querySelectorAll(".textLayerItem"));
      let foundAny = false;

      // 1) direct span match
      spans.forEach((span) => {
        const s = (span.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!s) return;
        if (s.includes(q)) {
          foundAny = true;
          const r = span.getBoundingClientRect();
          const pr = pageContainer.getBoundingClientRect();
          const hl = document.createElement("div");
          hl.className = "pdf-perfect-highlight";
          hl.style.position = "absolute";
          hl.style.left = `${Math.round(r.left - pr.left)}px`;
          hl.style.top = `${Math.round(r.top - pr.top)}px`;
          hl.style.width = `${Math.max(2, Math.round(r.width))}px`;
          hl.style.height = `${Math.max(2, Math.round(r.height))}px`;
          hl.style.background = "rgba(255,255,0,0.6)";
          hl.style.pointerEvents = "none";
          hl.style.zIndex = 20;
          pageContainer.appendChild(hl);
        }
      });

      if (foundAny) return true;

      // 2) fuzzy: concatenate span texts with spaces and map offsets
      let concat = "";
      const mapping = []; // char idx -> span index
      spans.forEach((span, idx) => {
        const txt = (span.textContent || "").replace(/\s+/g, " ").trim();
        if (!txt) return;
        if (concat.length > 0) {
          mapping.push(-1); // space
          concat += " ";
        }
        for (let i = 0; i < txt.length; i++) {
          mapping.push(idx);
        }
        concat += txt;
      });

      const lowerConcat = concat.toLowerCase();
      const pos = lowerConcat.indexOf(q);
      if (pos !== -1) {
        // determine span indices covering the match
        const startSpan = mapping[Math.max(0, pos)];
        const endSpan = mapping[Math.max(0, pos + q.length - 1)];
        if (startSpan != null && endSpan != null && startSpan >= 0 && endSpan >= 0) {
          const rects = [];
          for (let si = startSpan; si <= endSpan; si++) {
            const span = spans[si];
            if (!span) continue;
            rects.push(span.getBoundingClientRect());
          }
          if (rects.length) {
            const pr = pageContainer.getBoundingClientRect();
            const left = Math.min(...rects.map((r) => r.left));
            const top = Math.min(...rects.map((r) => r.top));
            const right = Math.max(...rects.map((r) => r.right));
            const bottom = Math.max(...rects.map((r) => r.bottom));
            const hl = document.createElement("div");
            hl.className = "pdf-perfect-highlight";
            hl.style.position = "absolute";
            hl.style.left = `${Math.round(left - pr.left)}px`;
            hl.style.top = `${Math.round(top - pr.top)}px`;
            hl.style.width = `${Math.round(right - left)}px`;
            hl.style.height = `${Math.round(bottom - top)}px`;
            hl.style.background = "rgba(255,255,0,0.6)";
            hl.style.pointerEvents = "none";
            hl.style.zIndex = 20;
            pageContainer.appendChild(hl);
            foundAny = true;
          }
        }
      }

      return foundAny;
    },
    [clearAllHighlights]
  );

  // Public handler: jump to page and highlight the phrase
  const showAndHighlightText = ({ refKey, searchTerm, persistent = false }) => {
    const pageNumber = refKey === "p3" ? 3 : refKey === "p5" ? 5 : 15;

    setActiveRef(refKey);
    setHighlightActive(true);

    // clear previous highlights
    clearAllHighlights();

    // scroll to page
    setTimeout(() => {
      const pageObj = pageRefs.current[pageNumber];
      if (pageObj && pageObj.pageContainer && containerRef.current) {
        // scroll container so the target page is centered
        const containerRect = containerRef.current.getBoundingClientRect();
        const pageRect = pageObj.pageContainer.getBoundingClientRect();
        const offset = pageRect.top - containerRect.top - containerRect.height / 2 + pageRect.height / 2;
        containerRef.current.scrollBy({ top: offset, behavior: "smooth" });
      }
    }, 120);

    // attempt highlight after short delay
    setTimeout(() => {
      const ok = highlightText(pageNumber, searchTerm);
      if (!ok) {
        // fallback: draw approximate overlay using highlightBoxes (kept simple)
        // compute approximate top-left inside container
        const hb = highlightBoxes[refKey];
        if (hb && pageRefs.current[pageNumber]) {
          const pageObj = pageRefs.current[pageNumber];
          const pr = pageObj.pageContainer.getBoundingClientRect();
          const left = Math.round(pr.left + pr.width * hb.leftPct - containerRef.current.getBoundingClientRect().left);
          const top = Math.round(pr.top + pr.height * hb.topPct - containerRef.current.getBoundingClientRect().top);
          const w = Math.round(pr.width * hb.widthPct);
          const h = hb.heightPx;
          const hl = document.createElement("div");
          hl.className = "pdf-perfect-highlight";
          hl.style.position = "absolute";
          // position relative to page container
          hl.style.left = `${Math.round(pr.width * hb.leftPct)}px`;
          hl.style.top = `${Math.round(pr.height * hb.topPct)}px`;
          hl.style.width = `${w}px`;
          hl.style.height = `${h}px`;
          hl.style.background = "rgba(255,255,0,0.6)";
          hl.style.pointerEvents = "none";
          hl.style.zIndex = 20;
          pageObj.pageContainer.appendChild(hl);
        }
      }
    }, 420);

    if (typeof persistent === "boolean") setPinned(Boolean(persistent));
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    if (!persistent) {
      hideTimeoutRef.current = setTimeout(() => {
        clearAllHighlights();
        setHighlightActive(false);
      }, 4500);
    }
  };

  // Analysis panel content (exact text you provided), with clickable citations
  const AnalysisPanel = ({ onCite }) => {
    const CiteButton = ({ id }) => (
      <button
        onClick={() =>
          onCite({
            refKey: id,
            searchTerm:
              id === "p3"
                ? "EBITDA of USD 2.3"
                : id === "p5"
                ? "EBITDA increased to USD 2.3"
                : "Gain on sale of non-current assets",
          })
        }
        style={{
          display: "inline-block",
          marginLeft: 6,
          marginRight: 2,
          background: "#1c965dff",
          borderRadius: 4,
          padding: "2px 6px",
          border: "none",
          cursor: "pointer",
          fontWeight: 700,
          fontSize: 12,
        }}
      >
        {id === "p3" ? "[1]" : id === "p5" ? "[2]" : "[3]"}
      </button>
    );

    return (
      <div style={{ ...styles.panelContent }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8, color: "#fff" }}>Analysis</div>

        <div style={{ fontSize: 13, color: "#fff", lineHeight: 1.4, marginBottom: 10 }}>
          <div>No extraordinary or one-off items affecting EBITDA were reported in Maersk’s Q2 2025 results.</div>

          <div style={{ marginTop: 8 }}>
            The report explicitly notes that EBITDA improvements stemmed from operational performance—including volume growth,
            cost control, and margin improvement across Ocean, Logistics &amp; Services, and Terminals segments
            <span style={{ marginLeft: 6 }} />
            <CiteButton id="p3" />
            <CiteButton id="p5" />
          </div>

          <div style={{ marginTop: 10 }}>
            Gains or losses from asset sales, which could qualify as extraordinary items, are shown separately under <strong>EBIT</strong> and not included in EBITDA.
            The gain on sale of non-current assets was USD 25 m in Q2 2025, significantly lower than USD 208 m in Q2 2024, but these affect <strong>EBIT</strong>, not <strong>EBITDA</strong>
            <span style={{ marginLeft: 6 }} />
            <CiteButton id="p15" />
            .
          </div>

          <div style={{ marginTop: 10 }}>
            Hence, Q2 2025 EBITDA reflects core operating activities without one-off extraordinary adjustments.
          </div>
        </div>

        <div style={{ fontWeight: 700, marginTop: 8, color: "#fff" }}>Findings</div>

        <div style={{ marginTop: 8, fontSize: 13, color: "#fff", lineHeight: 1.45 }}>
          <div>
            <strong>Page 3 — Highlights Q2 2025</strong>
          </div>
          <div style={{ marginLeft: 8 }}>
            EBITDA increase (USD 2.3 bn vs USD 2.1 bn prior year) attributed to operational improvements; no mention of extraordinary or one-off items.
            <CiteButton id="p3" />
          </div>

          <div style={{ marginTop: 10 }}>
            <strong>Page 5 — Review Q2 2025</strong>
          </div>
          <div style={{ marginLeft: 8 }}>
            EBITDA rise driven by higher revenue and cost control across all segments; no extraordinary gains or losses included.
            <CiteButton id="p5" />
          </div>

          <div style={{ marginTop: 10 }}>
            <strong>Page 15 — Condensed Income Statement</strong>
          </div>
          <div style={{ marginLeft: 8 }}>
            Gain on sale of non-current assets USD 25 m (vs USD 208 m prior year) reported separately below EBITDA; therefore, not part of EBITDA.
            <CiteButton id="p15" />
          </div>
        </div>

        <div style={{ marginTop: 12, fontSize: 13, color: "#fff", lineHeight: 1.4 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Supporting Evidence</div>

          <div style={{ marginTop: 6 }}>
            <strong>[1]</strong> A.P. Moller – Maersk Q2 2025 Interim Report (7 Aug 2025) — Page 3 →{" "}
            <em style={{ color: "#ddd" }}>
              “Maersk’s results continued to improve year-on-year ... EBITDA of USD 2.3 bn (USD 2.1 bn) ... driven by volume and other revenue growth in Ocean, margin improvements in Logistics & Services and significant top line growth in Terminals.”
            </em>
          </div>

          <div style={{ marginTop: 8 }}>
            <strong>[2]</strong> A.P. Moller – Maersk Q2 2025 Interim Report (7 Aug 2025) — Page 5 →{" "}
            <em style={{ color: "#ddd" }}>
              “EBITDA increased to USD 2.3 bn (USD 2.1 bn) ... driven by higher revenue and cost management ... Ocean’s EBITDA ... slightly increased by USD 36 m ... Logistics & Services contributed significantly with a USD 71 m increase ... Terminals’ EBITDA increased by USD 50 m.”
            </em>
          </div>

          <div style={{ marginTop: 8 }}>
            <strong>[3]</strong> A.P. Moller – Maersk Q2 2025 Interim Report (7 Aug 2025) — Page 15 →{" "}
            <em style={{ color: "#ddd" }}>
              “Gain on sale of non-current assets, etc., net 25 (208) ... Profit before depreciation, amortisation and impairment losses, etc. (EBITDA) 2,298”
            </em>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={styles.app}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Maersk Q2 2025 — PDF Viewer</h1>

        <div style={{ display: "flex", gap: 8 }}>
          <button style={styles.pillButton} onClick={() => showAndHighlightText({ refKey: "p3", searchTerm: "EBITDA of USD 2.3" })}>
            [1] Page 3
          </button>
          <button style={styles.pillButton} onClick={() => showAndHighlightText({ refKey: "p5", searchTerm: "EBITDA increased to USD 2.3" })}>
            [2] Page 5
          </button>
          <button style={styles.pillButton} onClick={() => showAndHighlightText({ refKey: "p15", searchTerm: "Gain on sale of non-current assets" })}>
            [3] Page 15
          </button>
        </div>
      </div>

      <div style={styles.container}>
        {/* Viewer */}
        <div style={styles.viewerColumn}>
          <div style={styles.viewerBox}>
            <div
              ref={containerRef}
              id="pdf-react-container"
              style={{ width: "100%", height: "100%", overflow: "auto", position: "relative", padding: 8 }}
            />
          </div>
        </div>

        {/* Panel */}
        <aside style={styles.panel}>
          <div style={styles.panelInner}>
            <AnalysisPanel onCite={({ refKey, searchTerm }) => showAndHighlightText({ refKey, searchTerm })} />
          </div>
        </aside>
      </div>
    </div>
  );
}

/* Updated Styles */
const styles = {
  app: {
    padding: 20,
    fontFamily: "Inter, Arial, sans-serif",
    background: "#f3f4f6", // softer background
    height: "100vh",
    boxSizing: "border-box",
  },
  container: {
    display: "flex",
    gap: 20,
    alignItems: "flex-start",
  },
  viewerColumn: {
    flex: 2,
    minWidth: 640,
  },
  viewerBox: {
    position: "relative",
    height: "78vh",
    minHeight: 560,
    background: "#ffffff",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  panel: {
    flex: 1,
    minWidth: 360,
    padding: 12,
  },
  panelInner: {
    background: "#1f2937", // dark panel background
    borderRadius: 12,
    padding: 16,
    border: "1px solid #374151",
    maxHeight: "78vh",
    overflowY: "auto",
    color: "#f9fafb",
    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
  },
  panelContent: {
    whiteSpace: "pre-wrap",
    color: "#f9fafb",
    fontSize: 14,
    lineHeight: 1.5,
  },
  pillButton: {
    background: "#3b82f6", // bright blue
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "8px 14px",
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
    transition: "all 0.2s ease",
  },
  pillButtonHover: {
    background: "#2563eb",
    boxShadow: "0 4px 10px rgba(0,0,0,0.15)",
  },
};
