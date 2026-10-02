import type { IslandScene } from "./scene.js";
import { badge, esc, layout, nodeTable, type LiveOptions, type NoticeOptions } from "../views.js";

// 3D island view page (M25.1): embeds the scene descriptor as JSON and boots
// the three.js projector. The flat island + text table stay on the page, so
// a missing WebGL context degrades to a truthful fallback, never a blank.
export function renderIsland3d(
  featureId: string,
  scene: IslandScene,
  live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string,
): string {
  // Script raw-text elements do NOT decode HTML entities, so the payload
  // must stay valid JSON: escape only `<` (breaks `</script>` breakout)
  // instead of HTML-escaping the whole document.
  const payload = JSON.stringify(scene).replace(/</g, "\\u003c");
  const headExtra =
    `<script type="importmap">{"imports":{"three":"/ui-static/three-build/three.module.js","three/addons/controls/OrbitControls.js":"/ui-static/OrbitControls.js"}}</script>` +
    `<script type="module" src="/ui-static/island3d-client.js"></script>` +
    `<script>(function(){window.addEventListener("error",function(){if(!window.__atlasIsland3dReady&&document.getElementById("island3d-canvas")){var f=document.getElementById("island3d-fallback");if(f)f.hidden=false;}});})();</script>`;
  const body =
    `<h2>${esc(scene.runTitle)} ${badge(scene.runStatus)} <span class="tag">3D island</span></h2>` +
    `<p class="muted">Experimental WebGL projection of live Atlas state. The flat Island below remains the authoritative display. No actions here; nothing here mutates Atlas.</p>` +
    `<p><a class="btn" href="/run?feature=${esc(featureId)}&view=island">← flat Island</a> <a class="btn" href="/run?feature=${esc(featureId)}&view=island&mode=proto">← 2.5D prototype</a></p>` +
    `<div id="island3d-root" style="position:relative;"><canvas id="island3d-canvas" tabindex="0" style="width:100%;height:520px;display:block;background:#0a121c;border:1px solid #21262d;border-radius:8px;" role="img" aria-label="3D Atlas island projection. Use Tab to reach the text equivalent below for full keyboard access."></canvas>` +
    `<div id="island3d-fallback" hidden><div class="empty">WebGL is unavailable in this browser — showing the flat Island and text workflow instead (same Atlas state, no information lost).</div></div></div>` +
    `<script type="application/json" id="island3d-data">${payload}</script>` +
    `<h2>Island nodes (text equivalent)</h2>${nodeTable(featureId, scene.buildings.map((b) => ({ id: b.taskId, title: b.title, status: b.status, workerId: b.worker?.id ?? null, workerLink: b.worker?.link ?? "none", wave: b.wave, verdict: b.verdict, integrated: b.integrated, dependsOn: b.dependsOn })))}`;
  return layout("3d island", featureId, "island", body, live, notice, headExtra, undefined, hudHtml);
}
