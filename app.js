/* ==========================================================================
   MIHAL GUREVICH — PORTFOLIO APPLICATION LOGIC
   Strict Manual Play / Pause Video Control Engine (No Auto-Resuming When Paused)
   ========================================================================== */

// ==========================================================================
// EDIT MODE — one switch for the whole editing / management interface.
//
// Off, the site is client-ready: no upload zones, no edit or delete buttons,
// no selection boxes, no drag-to-reorder, nothing is ever written back to
// projects.json, and projects that have no media yet are not shown. Every
// piece of the editing setup is still here, untouched — it is only hidden
// (html.edit-mode in style.css) and its handlers stand down.
//
// To bring it all back: set EDIT_MODE_DEFAULT to true.
// On her own machine only, adding ?edit to the address bar
// (http://localhost:5500/?edit) turns it on for that visit without a code
// change; a published site can never be switched on this way.
// ==========================================================================
const EDIT_MODE_DEFAULT = false;
const EDIT_MODE = EDIT_MODE_DEFAULT ||
  (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) &&
   new URLSearchParams(location.search).has('edit'));
document.documentElement.classList.toggle('edit-mode', EDIT_MODE);

// The showreel's sound icon: a speaker with waves when the reel is audible,
// struck through when it is muted. It only ever shows state as an icon.
function paintReelSound(btn, muted) {
  if (!btn) return;
  btn.classList.toggle('is-muted', muted);
  btn.setAttribute('aria-pressed', String(!muted));
}

document.addEventListener('DOMContentLoaded', () => {

  let userManuallyPausedMainReel = false;

  // ------------------------------------------------------------------------
  // 1. BACKEND DISK & LOCAL STORAGE SYNC ENGINE (100% PERSISTENCE)
  // ------------------------------------------------------------------------
  function fileToDataURL(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }

  async function uploadFileToSiteFolder(file, customFilename = '') {
    if (!file) return '';
    const fn = customFilename || file.name || `file_${Date.now()}`;
    const cleanFn = fn.replace(/\s+/g, '_');

    // List of server endpoints to attempt uploading to (3 minutes timeout for large video files!)
    const serverEndpoints = [
      `./upload?filename=${encodeURIComponent(cleanFn)}`,
      `http://127.0.0.1:5500/upload?filename=${encodeURIComponent(cleanFn)}`,
      `/upload?filename=${encodeURIComponent(cleanFn)}`
    ];

    for (const url of serverEndpoints) {
      try {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        }, 180000); // 180 SECONDS TIMEOUT FOR LARGE VIDEO FILES!

        if (res.ok) {
          const data = await res.json();
          console.log('[SERVER UPLOAD SUCCESS] Saved to site folder:', data.path);
          return data.path;
        }
      } catch (e) {
        console.warn('Upload endpoint failed:', url, e);
      }
    }

    // Fallback: Convert to persistent Data URL (Base64) so it saves offline permanently!
    console.warn('[OFFLINE FALLBACK] Server offline or file protocol, converting to persistent Data URL...');
    const dataUrl = await fileToDataURL(file);
    return dataUrl || URL.createObjectURL(file);
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 1200) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      throw error;
    }
  }

  // ------------------------------------------------------------------------
  // LOCAL EDIT OVERLAY
  // Text typed into an open project is kept in a store of its own, keyed by
  // project id, separate from the cached copy of the projects array.
  //
  // It has to be separate. loadProjectsFromSiteDisk prefers projects.json off
  // the server and writes it over the cached array, so an edit saved into
  // that cache is gone the next time the file is reachable — which, on the
  // live site, is every single load. The overlay is re-applied ON TOP of
  // whatever the loader returns, so an edit survives a reload, a cache
  // refresh, a newer projects.json and a browser restart. It is dropped only
  // when it has been written back into the source by hand.
  // ------------------------------------------------------------------------
  const EDITS_KEY = 'mihal_project_edits_v1';

  function readEditOverlay() {
    try {
      const raw = localStorage.getItem(EDITS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed : {};
    } catch (e) {
      console.warn('[EDITS] store unreadable, starting empty:', e);
      return {};
    }
  }

  function writeEditOverlay(all) {
    try {
      localStorage.setItem(EDITS_KEY, JSON.stringify(all));
      return true;
    } catch (e) {
      console.warn('[EDITS] could not be stored:', e);
      return false;
    }
  }

  // Merged, never replaced: saving one field leaves every other edited field
  // on that project alone.
  function recordEdit(id, patch) {
    if (!id) return false;
    const all = readEditOverlay();
    all[id] = Object.assign({}, all[id], patch, { savedAt: new Date().toISOString() });
    return writeEditOverlay(all);
  }

  function applyEditOverlay(list) {
    if (!Array.isArray(list)) return list;
    const all = readEditOverlay();
    const ids = Object.keys(all);
    if (!ids.length) return list;
    let hits = 0;
    list.forEach(proj => {
      if (!proj || !proj.id || !all[proj.id]) return;
      const patch = Object.assign({}, all[proj.id]);
      delete patch.savedAt;
      // A title saved blank in the browser (edited before it had one) never
      // wipes a title that has since been given in projects.json.
      if (!String(patch.title || '').trim() && String(proj.title || '').trim()) delete patch.title;
      Object.assign(proj, patch);
      hits++;
    });
    if (hits) console.log('[EDITS] re-applied local edits to ' + hits + ' project(s)');
    return list;
  }

  function countEditedProjects() {
    return Object.keys(readEditOverlay()).length;
  }

  // ------------------------------------------------------------------------
  // EXPORT
  // The whole projects array, as it stands on screen, ready to be pasted
  // back into projects.json so the edits stop being browser-only.
  // ------------------------------------------------------------------------
  function projectsAsJson() {
    return JSON.stringify(projects, null, 2);
  }

  async function copyProjectsJson() {
    const text = projectsAsJson();
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // The clipboard API is refused outside a secure context, which is
      // exactly where this page often runs, so fall back to a hidden field.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e2) {
        console.warn('[EXPORT] copy failed:', e2);
        return false;
      }
    }
  }

  function downloadProjectsJson() {
    try {
      const blob = new Blob([projectsAsJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'projects.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      console.warn('[EXPORT] download failed:', e);
      return false;
    }
  }

  // Also reachable from the console: exportProjects.copy() / .download()
  window.exportProjects = {
    copy: copyProjectsJson,
    download: downloadProjectsJson,
    json: projectsAsJson,
    edits: readEditOverlay
  };

  async function mergeProjectsWithDisk(currentLocalProjects) {
    try {
      const serverEndpoints = [
        './projects.json?v=' + Date.now(),
        'http://127.0.0.1:5500/projects.json?v=' + Date.now(),
        '/projects.json?v=' + Date.now()
      ];
      let diskProjects = null;
      for (const url of serverEndpoints) {
        try {
          const res = await fetchWithTimeout(url, {}, 1000);
          if (res.ok) {
            diskProjects = await res.json();
            if (diskProjects && Array.isArray(diskProjects)) break;
          }
        } catch (e) {}
      }

      if (!diskProjects || !Array.isArray(diskProjects)) return currentLocalProjects;

      const mergedMap = new Map();
      diskProjects.forEach(p => { if (p && p.id) mergedMap.set(p.id, p); });
      currentLocalProjects.forEach(p => { if (p && p.id) mergedMap.set(p.id, p); });

      return Array.from(mergedMap.values());
    } catch (e) {
      return currentLocalProjects;
    }
  }

  async function saveProjectsToSiteDisk(projectsArray) {
    if (!EDIT_MODE) return false;
    const finalProjects = projectsArray;

    // 1. Always save to LocalStorage first
    try {
      localStorage.setItem('mihal_projects_cms_v5', JSON.stringify(finalProjects));
    } catch (e) {
      console.warn('LocalStorage error:', e);
    }

    // 2. Sync to backend servers
    const serverEndpoints = [
      './save-projects',
      'http://127.0.0.1:5500/save-projects',
      '/save-projects'
    ];

    for (const url of serverEndpoints) {
      try {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(finalProjects)
        }, 1200);
        if (res.ok) {
          console.log('[SERVER DISK SAVE SUCCESS] Merged & saved projects.json to disk!');
          return true;
        }
      } catch (e) {}
    }

    // Every endpoint failed: the data is only in LocalStorage, not on disk.
    console.warn('[DISK SAVE FAILED] projects.json was not written; LocalStorage only.');
    return false;
  }

  async function loadProjectsFromSiteDisk() {
    // 1. Try server projects.json first (relative paths & fast 1.2s timeout)
    const serverEndpoints = [
      './projects.json?v=' + Date.now(),
      'http://127.0.0.1:5500/projects.json?v=' + Date.now(),
      '/projects.json?v=' + Date.now()
    ];

    for (const url of serverEndpoints) {
      try {
        const res = await fetchWithTimeout(url, {}, 1200);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data)) {
            console.log('[LOAD SUCCESS] Loaded projects from server projects.json');
            try { localStorage.setItem('mihal_projects_cms_v5', JSON.stringify(data)); } catch (e) {}
            return data;
          }
        }
      } catch (e) {}
    }

    // 2. Fallback to LocalStorage
    try {
      const saved = localStorage.getItem('mihal_projects_cms_v5');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed)) {
          console.log('[LOAD SUCCESS] Loaded projects from localStorage');
          return parsed;
        }
      }
    } catch (e) {}

    return null;
  }

  // AUTO-SYNC WHEN USER RETURNS TO TAB / RE-FOCUSES WINDOW
  window.addEventListener('focus', async () => {
    const updated = forVisitors(applyEditOverlay(await loadProjectsFromSiteDisk()));
    if (updated && Array.isArray(updated) && updated.length > 0) {
      if (JSON.stringify(updated) !== JSON.stringify(projects)) {
        projects = updated;
        renderPortfolio();
      }
    }
  });

  // ------------------------------------------------------------------------
  // 2. DEFAULT PROJECT DATASET (EXACTLY 2 WORK SQUARES UNDER SHOWREEL)
  // ------------------------------------------------------------------------
  const defaultProjects = [
    {
      id: "work-1",
      title: "Trailer Cut 01",
      subtitle: "Visual Identity & Motion Teaser",
      category: "Motion & Screen Graphics",
      catTag: "motion",
      year: "2026",
      client: "Mihal Gurevich Studio",
      role: "Motion Lead",
      toolkit: "After Effects, Blender",
      asset: "esset/motion_3d_render.jpg",
      videoAsset: "esset/trailer1.mp4",
      isVideo: true,
      aspectRatio: "16/9",
      description: "טיזר וידאו ומיתוג בתנועה."
    },
    {
      id: "work-2",
      title: "סילבסטר — בניין כלל",
      subtitle: "Motion Poster & Video Identity for Klal Building Sylvester Event",
      category: "Motion & Screen Graphics",
      catTag: "motion",
      year: "2026",
      client: "Mihal Gurevich Studio / בניין כלל",
      role: "Motion & 3D Lead",
      toolkit: "After Effects, Blender, Cinema 4D",
      asset: "esset/adom.jpg",
      videoAsset: "esset/m_3fb221306b.mp4",
      isVideo: true,
      aspectRatio: "3/4",
      description: "מערכת מיתוג בתנועה, פוסטר וידאו מקורי וויזואליה דינמית לאירוע סילבסטר בבניין כלל."
    }
  ];

  let projects = [];

  // A project with nothing to show (an upload that never attached) stays in
  // projects.json but is not shown to visitors. In edit mode everything shows.
  const hasMedia = (p) => Boolean(p && (p.asset || p.videoAsset ||
    (Array.isArray(p.gallery) && p.gallery.some(Boolean))));
  function forVisitors(list) {
    if (EDIT_MODE || !Array.isArray(list)) return list;
    return list.filter(hasMedia);
  }

  async function saveProjectsData() {
    if (!EDIT_MODE) return false;   // client-ready: the site never writes
    const seenIds = new Set();
    projects = projects.filter(p => {
      if (!p || !p.id || seenIds.has(p.id)) return false;
      seenIds.add(p.id);
      return true;
    });
    try { localStorage.setItem('mihal_projects_cms_v5', JSON.stringify(projects)); } catch (e) {}
    // true = written to projects.json on disk, false = LocalStorage only
    return await saveProjectsToSiteDisk(projects);
  }

  async function loadProjectsWithStorage() {
    const diskProjects = await loadProjectsFromSiteDisk();
    projects = (diskProjects !== null && diskProjects !== undefined) ? diskProjects : defaultProjects;
    // Anything edited in the browser goes back on top of the freshly loaded
    // copy, so a reload never reverts text that was saved here.
    applyEditOverlay(projects);
    projects = forVisitors(projects);

    renderPortfolio();

    // Load the main showreel, but do NOT start it here. It used to autoplay
    // the moment the page loaded, while it was still hidden behind the hero —
    // so by the time you had scrolled down to it you were dropped into the
    // middle of a reel that had been running to itself for half a minute.
    // It is started by the reveal instead, from the top, in setStage.
    //
    // This runs again every time the projects are re-fetched, which can land
    // AFTER the reel has already been revealed and started. Re-assigning the
    // source would then reload the file and knock it back to a standstill at
    // zero, so the source is only touched when it is not already set, and the
    // playback state is taken from the stage that is actually up.
    const mainVideo = document.getElementById('main-showreel');
    if (mainVideo) {
      const want = 'esset/showreel.mp4';
      if (!mainVideo.currentSrc || !mainVideo.currentSrc.endsWith(want)) {
        mainVideo.src = want;
        mainVideo.load();
      }
      mainVideo.muted = true;
      const onReel = document.body.classList.contains('stage-reel') &&
                     !document.body.classList.contains('stage-works');
      if (onReel) restartShowreel();
      else mainVideo.pause();
    }
  }

  // Rewind and play the reel. Seeking before the metadata is in is silently
  // ignored, which would leave it playing from wherever it happened to be,
  // so wait for the metadata when it is not there yet.
  function restartShowreel() {
    const v = document.getElementById('main-showreel');
    if (!v || userManuallyPausedMainReel) return;
    const go = () => {
      try { v.currentTime = 0; } catch (e) {}
      v.muted = true;
      v.play().catch(() => {});
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }

  document.addEventListener('visibilitychange', () => {
    // A muted, video-only element is paused by the browser itself whenever
    // the page goes out of sight, to save power, and it does not resume on
    // its own. Pick it up again when the tab comes back — from where it was,
    // not from the top: returning to a tab is not arriving at the reel.
    if (document.hidden) return;
    const v = document.getElementById('main-showreel');
    if (!v || userManuallyPausedMainReel || !v.paused) return;
    const onReel = document.body.classList.contains('stage-reel') &&
                   !document.body.classList.contains('stage-works');
    if (onReel) v.play().catch(() => {});
  });

  function stopShowreel() {
    const v = document.getElementById('main-showreel');
    if (!v) return;
    v.pause();
    try { v.currentTime = 0; } catch (e) {}
  }

  // ------------------------------------------------------------------------
  // CONTINUOUS POSTER CANVAS THEME ENGINE (DARK INK / WARM NEWSPRINT PAPER)
  // ------------------------------------------------------------------------
  const canvasToggleBtn = document.getElementById('canvas-theme-toggle');
  const canvasToggleText = document.getElementById('canvas-toggle-text');

  function updateCanvasThemeUI(isLight) {
    if (isLight) {
      document.body.classList.add('light-poster-canvas');
      if (canvasToggleText) canvasToggleText.textContent = 'DARK INK';
    } else {
      document.body.classList.remove('light-poster-canvas');
      if (canvasToggleText) canvasToggleText.textContent = 'LIGHT CANVAS';
    }
  }

  // THE INITIAL STATE IS DARK, stated outright rather than inferred from the
  // absence of a class. The light mode is only ever entered by an explicit
  // stored choice or a click, so a first paint can never come up light.
  let darkMode = true;
  updateCanvasThemeUI(false);
  try {
    const savedCanvasTheme = localStorage.getItem('mihal_canvas_mode_v2');
    if (savedCanvasTheme === 'light') {
      darkMode = false;
      updateCanvasThemeUI(true);
    }
  } catch (e) {}

  if (canvasToggleBtn) {
    canvasToggleBtn.addEventListener('click', () => {
      const isCurrentlyLight = document.body.classList.contains('light-poster-canvas');
      const nextIsLight = !isCurrentlyLight;
      updateCanvasThemeUI(nextIsLight);
      try {
        localStorage.setItem('mihal_canvas_mode_v2', nextIsLight ? 'light' : 'dark');
      } catch (e) {}
      showToast(nextIsLight ? '📰 פוסטר במצב נייר עיתון חם (Warm Newsprint Paper)' : '🖤 פוסטר במצב שחור דיו (Dark Poster Ink)');
    });
  }

  // ------------------------------------------------------------------------
  // 3. UNIFIED CLEAN PORTFOLIO GRID RENDERER
  // ------------------------------------------------------------------------
  const projectsGrid = document.getElementById('projects-grid');
  const gridCount = document.getElementById('grid-count');

  function isVideoUrl(url) {
    if (!url) return false;
    return url.startsWith('blob:') || url.startsWith('data:video') || url.endsWith('.mp4') || url.endsWith('.webm') || url.endsWith('.mov');
  }

  async function handleDropFilesOnCard(files, proj) {
    if (!files || files.length === 0 || !proj) return;

    showToast(`📥 מעלה ${files.length} קובץ/קבצים לתוך פרויקט "${proj.title || 'עבודה'}"...`);

    const uploadedPaths = [];
    let detectedAspect = proj.aspectRatio || '3/4';

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        if (i === 0) {
          const asp = await detectFileAspectRatio(file);
          if (asp) detectedAspect = asp;
        }
        const savedPath = await uploadFileToSiteFolder(file);
        if (savedPath) {
          uploadedPaths.push(savedPath);
        }
      } catch (err) {
        console.error('Upload error for file:', file.name, err);
      }
    }

    if (uploadedPaths.length === 0) {
      showToast('⚠️ העלאת הקבצים נכשלה. אנא נסה שוב.');
      return;
    }

    // Auto-update title if it's default
    if (!proj.title || proj.title === 'Portfolio Work' || proj.title.startsWith('work-')) {
      proj.title = files[0].name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
    }

    const firstFile = uploadedPaths[0];
    const firstIsVid = isVideoUrl(firstFile);

    proj.aspectRatio = detectedAspect;
    proj.isVideo = firstIsVid;

    if (firstIsVid) {
      proj.videoAsset = firstFile;
      if (!proj.asset || isVideoUrl(proj.asset)) {
        proj.asset = '';
      }
    } else {
      proj.asset = firstFile;
      proj.videoAsset = '';
    }

    if (!Array.isArray(proj.gallery)) {
      proj.gallery = [];
      if (proj.videoAsset && !proj.gallery.includes(proj.videoAsset)) proj.gallery.push(proj.videoAsset);
      if (proj.asset && !proj.gallery.includes(proj.asset)) proj.gallery.push(proj.asset);
    }

    if (uploadedPaths.length === 1) {
      // Exactly 1 file dropped:
      if (!proj.gallery.includes(firstFile)) {
        proj.gallery.unshift(firstFile);
      }
      proj.gallery = Array.from(new Set(proj.gallery.filter(Boolean)));
      await saveProjectsData();
      renderPortfolio();
      showToast(`✨ קובץ עודכן ונשמר בהצלחה לפרויקט "${proj.title}"!`);
    } else {
      // Multiple files dropped:
      // "שיוצג אחד מבחוץ אבל שמבפנים אוכל להציע כמה"
      // First file is the outside cover, all files are stored in gallery!
      const existing = proj.gallery.filter(url => !uploadedPaths.includes(url));
      proj.gallery = [...uploadedPaths, ...existing];
      proj.gallery = Array.from(new Set(proj.gallery.filter(Boolean)));
      await saveProjectsData();
      renderPortfolio();
      showToast(`✨ הועלו ${uploadedPaths.length} קבצים: קובץ ראשון מוצג בריבוע וכולם נשמרו בגלריה!`);
    }
  }

  // MULTI-PROJECT SELECTION & ABSORPTION ENGINE
  window.selectedProjectIds = window.selectedProjectIds || new Set();
  window.isCardDragging = false;
  window.draggedProjectId = null;
  window.draggedProjectIds = [];

  function updateFloatingSelectionBar() {
    const bar = document.getElementById('floating-selection-bar');
    const countEl = document.getElementById('selected-projects-count');
    if (!bar) return;

    // Prune any IDs that no longer exist in projects list
    const existingIds = new Set(projects.map(p => p.id));
    Array.from(window.selectedProjectIds).forEach(id => {
      if (!existingIds.has(id)) window.selectedProjectIds.delete(id);
    });

    const count = window.selectedProjectIds.size;
    if (countEl) countEl.textContent = count;

    if (count > 0) {
      bar.classList.add('active');
    } else {
      bar.classList.remove('active');
    }
  }

  function initFloatingSelectionBar() {
    const clearBtn = document.getElementById('floating-clear-btn');
    const mergeBtn = document.getElementById('floating-merge-btn');

    if (clearBtn && !clearBtn._bound) {
      clearBtn._bound = true;
      clearBtn.addEventListener('click', () => {
        window.selectedProjectIds.clear();
        document.querySelectorAll('.card-select-checkbox').forEach(cb => { cb.checked = false; });
        updateFloatingSelectionBar();
      });
    }

    if (mergeBtn && !mergeBtn._bound) {
      mergeBtn._bound = true;
      mergeBtn.addEventListener('click', () => {
        if (!window.selectedProjectIds || window.selectedProjectIds.size === 0) return;
        openTargetProjectSelector(Array.from(window.selectedProjectIds));
      });
    }
  }

  async function mergeProjectsIntoTarget(sourceIds, targetId, removeFromGrid = true) {
    if (!sourceIds || sourceIds.length === 0 || !targetId) return;
    const targetProj = projects.find(p => p.id === targetId);
    if (!targetProj) {
      showToast('⚠️ לא נמצא פרויקט יעד');
      return;
    }

    // Collect all media currently in target
    let targetMedia = [];
    if (Array.isArray(targetProj.gallery) && targetProj.gallery.length > 0) {
      targetMedia = [...targetProj.gallery];
    } else {
      if (targetProj.videoAsset) targetMedia.push(targetProj.videoAsset);
      if (targetProj.asset && !targetMedia.includes(targetProj.asset)) targetMedia.push(targetProj.asset);
    }

    let absorbedTitles = [];
    sourceIds.forEach(srcId => {
      if (srcId === targetId) return;
      const srcProj = projects.find(p => p.id === srcId);
      if (!srcProj) return;

      absorbedTitles.push(srcProj.title || 'פרויקט');

      let srcMedia = [];
      if (Array.isArray(srcProj.gallery) && srcProj.gallery.length > 0) {
        srcMedia = [...srcProj.gallery];
      } else {
        if (srcProj.videoAsset) srcMedia.push(srcProj.videoAsset);
        if (srcProj.asset && !srcMedia.includes(srcProj.asset)) srcMedia.push(srcProj.asset);
      }

      srcMedia.forEach(m => {
        if (m && !targetMedia.includes(m)) {
          targetMedia.push(m);
        }
      });
    });

    if (absorbedTitles.length === 0) return;

    targetProj.gallery = Array.from(new Set(targetMedia.filter(Boolean)));

    // Ensure target has active cover if it was empty
    if (!targetProj.videoAsset && !targetProj.asset && targetProj.gallery.length > 0) {
      const first = targetProj.gallery[0];
      if (isVideoUrl(first)) {
        targetProj.videoAsset = first;
        targetProj.isVideo = true;
      } else {
        targetProj.asset = first;
        targetProj.isVideo = false;
      }
    }

    if (removeFromGrid) {
      projects = projects.filter(p => !sourceIds.includes(p.id) || p.id === targetId);
    }

    sourceIds.forEach(id => window.selectedProjectIds.delete(id));
    updateFloatingSelectionBar();

    await saveProjectsData();
    renderPortfolio();

    if (currentModalProject && currentModalProject.id === targetId) {
      openProjectModal(targetProj);
    }

    showToast(`✨ ${absorbedTitles.length} פרויקט/ים הוכנסו בהצלחה לתוך "${targetProj.title || 'הפרויקט'}"!`);
  }

  function openProjectPickerModal(targetProject) {
    const overlay = document.getElementById('project-picker-overlay');
    const titleEl = document.getElementById('project-picker-title');
    const listEl = document.getElementById('project-picker-list');
    const removeLabel = document.getElementById('project-picker-remove-label');
    const removeCheckbox = document.getElementById('project-picker-remove-checkbox');
    const closeBtn = document.getElementById('project-picker-close-btn');
    const cancelBtn = document.getElementById('project-picker-cancel-btn');
    const submitBtn = document.getElementById('project-picker-submit-btn');

    if (!overlay || !listEl) return;

    if (titleEl) titleEl.textContent = `בחר פרויקטים להוספה לתוך "${targetProject.title || 'הפרויקט'}"`;
    if (removeLabel) removeLabel.style.display = 'flex';
    if (removeCheckbox) removeCheckbox.checked = true;
    if (submitBtn) submitBtn.textContent = '📥 הכנס פנימה לגלריה';

    const availableProjects = projects.filter(p => p.id !== targetProject.id);
    if (availableProjects.length === 0) {
      listEl.innerHTML = '<div style="color: #a4adcf; text-align: center; padding: 2rem;">אין פרויקטים נוספים זמינים בפורטפוליו.</div>';
    } else {
      listEl.innerHTML = availableProjects.map(p => {
        const thumb = p.asset || p.videoAsset || 'esset/placeholder_thumb.jpg';
        const isVid = isVideoUrl(thumb);
        const countMedia = (p.gallery && Array.isArray(p.gallery) ? p.gallery.length : 1) || 1;
        return `
          <div class="project-picker-item" data-id="${p.id}">
            <input type="checkbox" class="picker-item-checkbox" value="${p.id}">
            ${isVid ? `<video src="${thumb}" class="project-picker-thumb" muted playsinline></video>` : `<img src="${thumb}" class="project-picker-thumb" alt="">`}
            <div class="project-picker-info">
              <div class="project-picker-item-title">${p.title || 'פרויקט ללא שם'}</div>
              <div class="project-picker-item-sub">${p.category || ''} • ${countMedia} פריטי מדיה</div>
            </div>
          </div>
        `;
      }).join('');
    }

    listEl.querySelectorAll('.project-picker-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const cb = item.querySelector('.picker-item-checkbox');
        if (e.target !== cb) {
          cb.checked = !cb.checked;
        }
        item.classList.toggle('selected', cb.checked);
      });
    });

    overlay.classList.add('active');

    const closeOverlay = () => {
      overlay.classList.remove('active');
    };

    closeBtn.onclick = closeOverlay;
    cancelBtn.onclick = closeOverlay;

    submitBtn.onclick = async () => {
      const selectedBoxes = Array.from(listEl.querySelectorAll('.picker-item-checkbox:checked'));
      const selectedIds = selectedBoxes.map(cb => cb.value);
      if (selectedIds.length === 0) {
        showToast('⚠️ לא נבחרו פרויקטים');
        return;
      }
      const shouldRemove = removeCheckbox ? removeCheckbox.checked : true;
      closeOverlay();
      await mergeProjectsIntoTarget(selectedIds, targetProject.id, shouldRemove);
    };
  }

  function openTargetProjectSelector(sourceIds) {
    const overlay = document.getElementById('project-picker-overlay');
    const titleEl = document.getElementById('project-picker-title');
    const listEl = document.getElementById('project-picker-list');
    const removeLabel = document.getElementById('project-picker-remove-label');
    const removeCheckbox = document.getElementById('project-picker-remove-checkbox');
    const closeBtn = document.getElementById('project-picker-close-btn');
    const cancelBtn = document.getElementById('project-picker-cancel-btn');
    const submitBtn = document.getElementById('project-picker-submit-btn');

    if (!overlay || !listEl) return;

    if (titleEl) titleEl.textContent = `בחר פרויקט יעד שאליו יוכנסו ${sourceIds.length} הפרויקטים`;
    if (removeLabel) removeLabel.style.display = 'flex';
    if (removeCheckbox) removeCheckbox.checked = true;
    if (submitBtn) submitBtn.textContent = '📥 הכנס לתוך פרויקט היעד';

    const targetCandidates = projects.filter(p => !sourceIds.includes(p.id));
    if (targetCandidates.length === 0) {
      listEl.innerHTML = '<div style="color: #a4adcf; text-align: center; padding: 2rem;">אין פרויקטי יעד זמינים (כולם נבחרו).</div>';
    } else {
      listEl.innerHTML = targetCandidates.map(p => {
        const thumb = p.asset || p.videoAsset || 'esset/placeholder_thumb.jpg';
        const isVid = isVideoUrl(thumb);
        const countMedia = (p.gallery && Array.isArray(p.gallery) ? p.gallery.length : 1) || 1;
        return `
          <div class="project-picker-item target-candidate-item" data-id="${p.id}">
            <input type="radio" name="target-project-radio" class="picker-item-radio" value="${p.id}">
            ${isVid ? `<video src="${thumb}" class="project-picker-thumb" muted playsinline></video>` : `<img src="${thumb}" class="project-picker-thumb" alt="">`}
            <div class="project-picker-info">
              <div class="project-picker-item-title">${p.title || 'פרויקט ללא שם'}</div>
              <div class="project-picker-item-sub">${p.category || ''} • ${countMedia} פריטי מדיה קיימים</div>
            </div>
          </div>
        `;
      }).join('');
    }

    listEl.querySelectorAll('.target-candidate-item').forEach(item => {
      item.addEventListener('click', () => {
        listEl.querySelectorAll('.target-candidate-item').forEach(it => it.classList.remove('selected'));
        const radio = item.querySelector('.picker-item-radio');
        radio.checked = true;
        item.classList.add('selected');
      });
    });

    overlay.classList.add('active');

    const closeOverlay = () => {
      overlay.classList.remove('active');
    };

    closeBtn.onclick = closeOverlay;
    cancelBtn.onclick = closeOverlay;

    submitBtn.onclick = async () => {
      const selectedRadio = listEl.querySelector('.picker-item-radio:checked');
      if (!selectedRadio) {
        showToast('⚠️ אנא בחר פרויקט יעד');
        return;
      }
      const targetId = selectedRadio.value;
      const shouldRemove = removeCheckbox ? removeCheckbox.checked : true;
      closeOverlay();
      await mergeProjectsIntoTarget(sourceIds, targetId, shouldRemove);
    };
  }

  function renderPortfolio() {
    if (!projectsGrid) return;
    projectsGrid.innerHTML = '';

    initFloatingSelectionBar();
    updateFloatingSelectionBar();

    // On a phone the grid is two columns, so empty projects (still waiting
    // for their media) left whole blank rows at the foot of the works, even in
    // edit mode. They are skipped there when drawing only — never removed from
    // the data, so nothing is lost on a save.
    const onPhone = window.matchMedia('(max-width: 768px)').matches;
    const visibleProjects = onPhone ? projects.filter(hasMedia) : projects;

    visibleProjects.forEach((proj, idx) => {
      const galleryVideo = (proj.gallery && Array.isArray(proj.gallery)) ? proj.gallery.find(url => isVideoUrl(url)) : '';
      const videoPath = proj.videoAsset || galleryVideo || (isVideoUrl(proj.asset) ? proj.asset : '');
      const isVid = Boolean(videoPath);
      const hasExplicitStaticImg = Boolean(proj.asset && !isVideoUrl(proj.asset));
      const staticImgPath = hasExplicitStaticImg ? proj.asset : '';

      const card = document.createElement('div');
      // Every card is the same box on the rail; the thumbnail is cropped to
      // fill it. Varied aspect ratios are what broke the rank of the
      // reference's grid.
      card.className = 'project-item works-card';
      card.setAttribute('data-category', proj.catTag);
      card.setAttribute('data-id', proj.id);
      card.setAttribute('draggable', EDIT_MODE ? 'true' : 'false');

      let thumbPath = '';
      if (isVid && videoPath.startsWith('esset/')) {
        const fileName = videoPath.split('/').pop();
        const baseName = fileName.substring(0, fileName.lastIndexOf('.'));
        thumbPath = `esset/thumbs/${baseName}.jpg`;
      }

        // AT REST THIS IS ALWAYS AN <img>, NEVER A <video>.
        // A video element paints its OWN opaque black behind a letterboxed
        // frame, and no CSS background reaches that — which is why the video
        // cards sat in black boxes while the still cards showed the ground
        // through. The clip is layered over the still and only revealed on
        // hover, sized to the still's exact rect so it has no letterbox
        // either.
        const stillPath = hasExplicitStaticImg ? staticImgPath
                        : (thumbPath || 'esset/placeholder_thumb.jpg');

        // Counting UP from the left, in reading order. The rail fills
        // column-first over two rows, so 01 sits above 02 in the leftmost
        // column and the count runs rightwards from there. Padded to two
        // digits so the row of numbers keeps one width.
        const workNo = padWorkNo(idx + 1);

        card.innerHTML = `
          <div class="works-num"><span class="works-num-ink">${workNo}.</span></div>
          <div class="media-container works-thumb" id="media-square-${proj.id}">
            <div class="card-select-checkbox-wrapper" title="בחר פרויקט למיזוג / גרירה מרובה">
              <input type="checkbox" class="card-select-checkbox" data-id="${proj.id}" ${window.selectedProjectIds && window.selectedProjectIds.has(proj.id) ? 'checked' : ''}>
            </div>
            ${`
              <img src="${stillPath}" alt="${proj.title}" class="thumb-img" draggable="false" loading="eager"${hasExplicitStaticImg ? ` onerror="handleAssetError(this, '${staticImgPath}', '${proj.id}')"` : ''}>
              ${isVid ? `<video class="hover-video-loop" muted loop playsinline preload="none" draggable="false"><source src="${videoPath}" type="video/mp4"></video>` : ''}
            `}
          </div>
        `;

      // BIND CHECKBOX SELECTION
      const selectCheckbox = card.querySelector('.card-select-checkbox');
      if (selectCheckbox) {
        selectCheckbox.addEventListener('click', (e) => {
          e.stopPropagation();
        });
        selectCheckbox.addEventListener('change', (e) => {
          e.stopPropagation();
          if (selectCheckbox.checked) {
            window.selectedProjectIds.add(proj.id);
          } else {
            window.selectedProjectIds.delete(proj.id);
          }
          updateFloatingSelectionBar();
        });
      }

      // INTERACTIVE CARD DRAGGING (DRAG SINGLE OR MULTIPLE PROJECTS TO SWAP OR ABSORB INSIDE)
      card.addEventListener('dragstart', (e) => {
        if (!EDIT_MODE) return;
        if (e.target.closest('button') || e.target.closest('.card-select-checkbox-wrapper')) {
          e.preventDefault();
          return;
        }
        window.isCardDragging = true;
        if (window.selectedProjectIds && window.selectedProjectIds.has(proj.id) && window.selectedProjectIds.size > 1) {
          window.draggedProjectIds = Array.from(window.selectedProjectIds);
        } else {
          window.draggedProjectIds = [proj.id];
        }
        window.draggedProjectId = proj.id;
        e.dataTransfer.setData('text/plain', JSON.stringify(window.draggedProjectIds));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('card-dragging');
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('card-dragging');
        document.querySelectorAll('.card-drag-over, .card-drop-swap, .card-drop-inside').forEach(el => {
          el.classList.remove('card-drag-over', 'card-drop-swap', 'card-drop-inside');
        });
        setTimeout(() => {
          window.isCardDragging = false;
          window.draggedProjectId = null;
          window.draggedProjectIds = [];
        }, 200);
      });

      let cardDragCounter = 0;

      card.addEventListener('dragenter', (e) => {
        e.preventDefault();
        cardDragCounter++;
        const isFile = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
        if (isFile) {
          card.classList.add('card-file-hover');
        }
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        const isFile = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
        if (isFile) {
          e.dataTransfer.dropEffect = 'copy';
          if (!card.classList.contains('card-file-hover')) card.classList.add('card-file-hover');
        } else if (window.isCardDragging && (!window.draggedProjectIds || !window.draggedProjectIds.includes(proj.id))) {
          e.dataTransfer.dropEffect = 'move';
          const isMultipleSelected = window.draggedProjectIds && window.draggedProjectIds.length > 1;
          const isAltPressed = e.altKey;

          if (isMultipleSelected || isAltPressed) {
            // INTENTIONAL MERGE: Multiple items selected via checkbox OR Alt/Option key held down
            card.classList.remove('card-drag-over', 'card-drop-swap');
            card.classList.add('card-drop-inside');
            card.setAttribute('data-drop-mode', 'inside');
          } else {
            // NORMAL SINGLE CARD DRAG IS ALWAYS SAFE SWAP / REORDER!
            card.classList.remove('card-drop-inside');
            card.classList.add('card-drag-over', 'card-drop-swap');
            card.setAttribute('data-drop-mode', 'swap');
          }
        }
      });

      card.addEventListener('dragleave', (e) => {
        e.preventDefault();
        cardDragCounter--;
        if (cardDragCounter <= 0) {
          cardDragCounter = 0;
          card.classList.remove('card-file-hover', 'card-drag-over', 'card-drop-swap', 'card-drop-inside');
        }
      });

      card.addEventListener('drop', async (e) => {
        if (!EDIT_MODE) return;
        e.preventDefault();
        e.stopPropagation(); // PREVENT BUBBLING TO WINDOW DROP HANDLER!
        cardDragCounter = 0;
        const dropMode = card.getAttribute('data-drop-mode') || 'swap';
        card.classList.remove('card-drag-over', 'card-file-hover', 'card-drop-swap', 'card-drop-inside');

        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          await handleDropFilesOnCard(Array.from(e.dataTransfer.files), proj);
          return;
        }

        let draggedIds = window.draggedProjectIds;
        if (!draggedIds || draggedIds.length === 0) {
          const raw = window.draggedProjectId || e.dataTransfer.getData('text/plain');
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) draggedIds = parsed;
            else if (typeof parsed === 'string') draggedIds = [parsed];
          } catch {
            if (raw) draggedIds = [raw];
          }
        }

        if (!draggedIds || draggedIds.length === 0) return;
        draggedIds = draggedIds.filter(id => id !== proj.id);
        if (draggedIds.length === 0) return;

        // ABSORB & MERGE ONLY IF MULTIPLE PROJECTS ARE DRAGGED OR ALT WAS HELD
        if (dropMode === 'inside' && (draggedIds.length > 1 || e.altKey)) {
          window.draggedProjectId = null;
          window.draggedProjectIds = [];
          await mergeProjectsIntoTarget(draggedIds, proj.id, true);
        } else {
          // SAFE SWAP POSITIONS (REORDER) FOR SINGLE CARDS
          const draggedId = draggedIds[0];
          const fromIdx = projects.findIndex(p => p.id === draggedId);
          const toIdx = projects.findIndex(p => p.id === proj.id);

          if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
            const temp = projects[fromIdx];
            projects[fromIdx] = projects[toIdx];
            projects[toIdx] = temp;

            window.draggedProjectId = null;
            window.draggedProjectIds = [];
            await saveProjectsData();
            renderPortfolio();
            showToast(`✓ מיקומי הפרויקטים הוחלפו ונשמרו!`);
          }
        }
      });

      card.addEventListener('click', (e) => {
        if (window.isCardDragging) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        if (e.target.closest('.card-select-checkbox-wrapper')) {
          return;
        }
        if (e.target.closest('.quick-edit-tile-btn')) {
          e.stopPropagation();
          openCardEditor(proj, false);
        } else if (e.target.closest('.inline-add-plus-btn')) {
          e.stopPropagation();
          openCardEditor({
            id: `work-${Date.now()}`,
            title: '',
            subtitle: '',
            category: 'Motion & Screen Graphics',
            catTag: 'motion',
            year: '',
            client: '',
            toolkit: '',
            role: '',
            asset: '',
            videoAsset: '',
            description: ''
          }, true, proj.id);
        } else {
          openProjectModal(proj);
        }
      });

      // REORDER PROJECT POSITIONS (PERSISTENT TO DISK)
      const moveUpBtn = card.querySelector('.move-up-btn');
      if (moveUpBtn) {
        moveUpBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetIdx = parseInt(moveUpBtn.getAttribute('data-idx'));
          if (targetIdx > 0) {
            const temp = projects[targetIdx];
            projects[targetIdx] = projects[targetIdx - 1];
            projects[targetIdx - 1] = temp;
            saveProjectsData();
            renderPortfolio();
          }
        });
      }

      const moveDownBtn = card.querySelector('.move-down-btn');
      if (moveDownBtn) {
        moveDownBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetIdx = parseInt(moveDownBtn.getAttribute('data-idx'));
          if (targetIdx < projects.length - 1) {
            const temp = projects[targetIdx];
            projects[targetIdx] = projects[targetIdx + 1];
            projects[targetIdx + 1] = temp;
            saveProjectsData();
            renderPortfolio();
          }
        });
      }

      // FIRST FRAME STILL UNTIL HOVER LOGIC (GRID HOVER IS ALWAYS MUTED; AUDIO PLAYS ONLY ON CLICK!)
      // startTime lets a project open on a chosen moment instead of frame 0 —
      // needed for films that open on a black screen.
      const startAt = Number(proj.startTime) || 0;

      const bindHoverPreview = (video) => {
        if (!video) return;

        // These previews are preload="none", so currentTime is ignored until
        // metadata exists. Seek now if we can, otherwise seek on loadedmetadata.
        const seekToStart = () => {
          if (!startAt) return;
          if (video.readyState >= 1) {
            try { video.currentTime = startAt; } catch (e) {}
          } else {
            video.addEventListener('loadedmetadata', () => {
              try { video.currentTime = startAt; } catch (e) {}
            }, { once: true });
          }
        };

        card.addEventListener('mouseenter', () => {
          video.muted = true; // PREVIEWS REMAIN MUTED ON HOVER
          if (startAt && video.currentTime < startAt) seekToStart();
          applyClipSpeed(video, proj);
          video.play().catch(() => {});
        });

        card.addEventListener('mouseleave', () => {
          video.pause();
          if (startAt) seekToStart();
          else { try { video.currentTime = 0; } catch (e) {} }
        });
      };

      bindHoverPreview(card.querySelector('.hover-video-loop'));
      fitClipToStill(card);

      // Hovering a work writes its line into the band under the rail.
      card.addEventListener('mouseenter', () => setMarqueeFor(proj, idx));

      // CLICK PROJECT CARD -> OPEN MODAL WITH SUBMARINE BLUE BLUR BACKDROP
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('.card-direct-buttons')) {
          return;
        }
        openProjectModal(proj);
      });

      // Click Edit Buttons -> Open Card Editor Modal
      const editBtn = card.querySelector(`#edit-btn-${proj.id}`);
      if (editBtn) {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openCardEditor(proj);
        });
      }

      const quickEditBtn = card.querySelector(`#quick-edit-${proj.id}`);
      if (quickEditBtn) {
        quickEditBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openCardEditor(proj);
        });
      }

      projectsGrid.appendChild(card);

    });

    // (The ADD NEW WORK tile that used to close the row is gone — removed at
    // her request. New work comes in by dropping files onto the page in edit mode.)

    if (gridCount) gridCount.textContent = `Showing ${visibleProjects.length} Projects`;

    renderWorksIndex(visibleProjects);

    // Something has to be running in the band before anything is hovered.
    if (visibleProjects.length) setMarqueeFor(visibleProjects[0], 0);

    // The cords are strung between the numbers that were just laid out, so
    // they have to be measured AFTER the grid has been through a layout.
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('mihal:portfolio-rendered'));
    });
  }

  // ------------------------------------------------------------------------
  // THE INDEX UNDER THE RAIL
  // The rail shows the works; this names them. Four columns, filled DOWN each
  // one in turn so the numbering runs in reading order within a column rather
  // than skipping across the page. Hovering a line drives the same band the
  // thumbnails do, and clicking it opens the work.
  // ------------------------------------------------------------------------
  const worksIndexEl = document.getElementById('works-index');

  function renderWorksIndex(list) {
    if (!worksIndexEl) return;
    worksIndexEl.innerHTML = '';
    const perCol = Math.ceil(list.length / 4);

    for (let c = 0; c < 4; c++) {
      const col = document.createElement('ul');
      col.className = 'works-index-col';
      for (let r = 0; r < perCol; r++) {
        const idx = c * perCol + r;
        if (idx >= list.length) break;
        const proj = list[idx];
        const li = document.createElement('li');
        li.className = 'works-index-item';
        li.innerHTML =
          '<span class="works-index-num">' + padWorkNo(idx + 1) + '.</span>' +
          '<span class="works-index-title"></span>';
        // textContent, not innerHTML: a title is the user's own text and must
        // never be parsed as markup on its way back onto the page.
        li.querySelector('.works-index-title').textContent = proj.title || '';
        li.addEventListener('mouseenter', () => setMarqueeFor(proj, idx));
        li.addEventListener('click', () => openProjectModal(proj));
        col.appendChild(li);
      }
      worksIndexEl.appendChild(col);
    }
  }

  // ------------------------------------------------------------------------
  // THE HOVER CLIP SITS EXACTLY ON THE STILL
  // Sized to the box, a letterboxed video shows the element's own black to
  // either side. Sized to the rect the still actually occupies, there is no
  // letterbox left for it to fill — the clip and the still are the same
  // rectangle, so hovering swaps one for the other without anything moving.
  // ------------------------------------------------------------------------
  function fitClipToStill(card) {
    const img = card.querySelector('.thumb-img');
    const clip = card.querySelector('.hover-video-loop');
    if (!img || !clip) return;

    const place = () => {
      const box = img.getBoundingClientRect();
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh || !box.width) return;
      const scale = Math.min(box.width / nw, box.height / nh);
      // AS IMPORTANT. The stylesheet sizes every media element in a card to
      // 100% with !important; a plain inline width loses to that, the clip
      // fell back to a video element's default 300x150, and hovering jumped
      // the image up by a fifth — the "zoom" on hover.
      clip.style.setProperty('width', (nw * scale) + 'px', 'important');
      clip.style.setProperty('height', (nh * scale) + 'px', 'important');
    };

    if (img.complete) place();
    else img.addEventListener('load', place, { once: true });
    card._placeClip = place;
  }

  // Card width only changes at the breakpoint, but the stills have to be
  // re-measured when it does.
  let clipFitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(clipFitTimer);
    clipFitTimer = setTimeout(() => {
      document.querySelectorAll('.works-card').forEach(c => c._placeClip && c._placeClip());
    }, 140);
  });

  // ------------------------------------------------------------------------
  // THE LINE UNDER THE RAIL
  // One long line of type that never stops moving, carrying whichever work
  // the cursor is over. The text is written twice end to end and the track is
  // slid by exactly half its length, so the loop has no seam.
  // ------------------------------------------------------------------------
  const marqueeTrack = document.getElementById('works-marquee-track');

  const MARQUEE_REPEATS = 12;

  // ONE colour per work, not a cycle within a work. In the reference each
  // entry carries a single flat colour across its whole block; running six
  // colours through one line turned it into a train of stripes. The colour
  // changes when you move to another work, which is the whole point of it.
  const MARQUEE_PALETTE = [
    '#3CB54A', '#F5821F', '#2E7FE8', '#FF3DDB', '#D4FF00', '#5FFBD8'
  ];

  function setMarqueeFor(proj, idx) {
    if (!marqueeTrack || !proj) return;
    const line = [proj.title, proj.client, proj.year]
      .map(v => (v || '').toString().trim())
      .filter(Boolean)
      .join(', ');
    if (!line) return;
    // The colour goes on the BAND, not on each word: painted per item, the
    // gaps between them let the blue ground through and the strip came out
    // striped.
    // On the SECTION, not the band: the colour is now in the letterforms and
    // the rule that reads it lives on the items, so the variable has to be
    // somewhere both can inherit it from.
    const band = marqueeTrack.closest('.poster-portfolio-section') ||
                 marqueeTrack.parentElement || marqueeTrack;
    band.style.setProperty(
      '--marquee-colour',
      MARQUEE_PALETTE[(idx || 0) % MARQUEE_PALETTE.length]
    );
    marqueeTrack.innerHTML =
      `<span class="works-marquee-item">${line}</span>`.repeat(MARQUEE_REPEATS);

    // Restart the run from its head. Replacing the text alone leaves the
    // animation where it was, so a new title appeared already halfway across
    // the screen. Dropping the animation, forcing a reflow and putting it
    // back is what actually resets it.
    marqueeTrack.style.animation = 'none';
    void marqueeTrack.offsetWidth;
    marqueeTrack.style.animation = '';
  }

  // The masonry placer that used to live here is gone with the layout it
  // described: the works are a two-row rail of identical boxes now, so there
  // are no varying card heights to pack and no columns to balance.


  window.handleAssetError = function(imgElement, assetPath, projId) {
    const parent = imgElement.parentElement;
    if (!parent) return;

    imgElement.style.display = 'none';
    let placeholder = parent.querySelector('.asset-placeholder-box');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'asset-placeholder-box';
      placeholder.innerHTML = ''; // 100% EMPTY — ZERO TEXT!
      parent.appendChild(placeholder);
    }
  };

  loadProjectsWithStorage();

  // INFO & CONTACT MODAL CONTROLLERS FOR HEADER DIVIDER (info • contact • cv)
  const navInfoLink = document.getElementById('nav-link-info');
  const navContactLink = document.getElementById('nav-link-contact');
  const infoModal = document.getElementById('info-modal');
  const contactModal = document.getElementById('contact-modal');
  const infoModalCloseBtn = document.getElementById('info-modal-close-btn');
  const contactModalCloseBtn = document.getElementById('contact-modal-close-btn');

  if (navInfoLink && infoModal) {
    navInfoLink.addEventListener('click', (e) => {
      e.preventDefault();
      infoModal.classList.add('active');
    });
  }

  if (navContactLink && contactModal) {
    navContactLink.addEventListener('click', (e) => {
      e.preventDefault();
      contactModal.classList.add('active');
    });
  }

  if (infoModalCloseBtn && infoModal) {
    infoModalCloseBtn.addEventListener('click', () => {
      infoModal.classList.remove('active');
    });
  }

  if (contactModalCloseBtn && contactModal) {
    contactModalCloseBtn.addEventListener('click', () => {
      contactModal.classList.remove('active');
    });
  }

  // ------------------------------------------------------------------------
  // 4. CARD EDITOR MODAL (INSTANT FILE AUTO-UPLOAD & DISK PERSISTENCE ENGINE)
  // ------------------------------------------------------------------------
  const cardEditorModal = document.getElementById('card-editor-modal');
  const cardEditorForm = document.getElementById('card-editor-form');
  const cardEditorCloseBtn = document.getElementById('card-editor-close-btn');
  const cardEditorCancelBtn = document.getElementById('card-editor-cancel-btn');
  const saveCardSubmitBtn = document.getElementById('save-card-submit-btn');
  const deleteCurrentProjectBtn = document.getElementById('delete-current-project-btn');

  const editProjectId = document.getElementById('edit-project-id');
  const editTitle = document.getElementById('edit-title');
  const editCategory = document.getElementById('edit-category');
  const editYear = document.getElementById('edit-year');
  const editClient = document.getElementById('edit-client');
  const editRole = document.getElementById('edit-role');
  const editToolkit = document.getElementById('edit-toolkit');
  const editDesc = document.getElementById('edit-desc');
  const editProjectAssetUrl = document.getElementById('edit-project-asset-url');
  const editProjectVideoUrl = document.getElementById('edit-project-video-url');
  const editGalleryUrls = document.getElementById('edit-gallery-urls');

  const modalFileImg = document.getElementById('modal-file-image');
  const modalFileVid = document.getElementById('modal-file-video');
  const modalFileGallery = document.getElementById('modal-file-gallery');

  let isNewProjectMode = false;

  function openCardEditor(proj, isNew = false, afterId = null) {
    if (!cardEditorModal) return;
    isNewProjectMode = isNew;
    window.insertAfterProjectId = afterId;

    editProjectId.value = proj.id;
    editTitle.value = proj.title || '';
    editCategory.value = proj.catTag || 'motion';
    editYear.value = proj.year || '';
    if (editClient) editClient.value = proj.client || '';
    if (editRole) editRole.value = proj.role || '';
    editToolkit.value = proj.toolkit || '';
    editDesc.value = proj.description || proj.subtitle || '';
    editProjectAssetUrl.value = proj.asset || '';
    editProjectVideoUrl.value = proj.videoAsset || '';
    if (editGalleryUrls) {
      editGalleryUrls.value = (proj && proj.gallery && Array.isArray(proj.gallery)) ? proj.gallery.join(', ') : '';
    }

    if (modalFileImg) modalFileImg.value = '';
    if (modalFileVid) modalFileVid.value = '';
    if (modalFileGallery) modalFileGallery.value = '';

    if (deleteCurrentProjectBtn) {
      deleteCurrentProjectBtn.style.display = isNew ? 'none' : 'inline-block';
    }

    closeModal();
    cardEditorModal.classList.add('active');
    
    // ZERO DATA LOSS SAFEGUARD: Continuous Auto-Save for Modal
    let modalAutoSaveTimer = null;
    const saveSilent = async () => {
      const pid = editProjectId.value;
      const existingIdx = projects.findIndex(p => p.id === pid);
      if (existingIdx !== -1) {
        projects[existingIdx].title = editTitle.value.trim();
        projects[existingIdx].description = editDesc.value.trim();
        projects[existingIdx].subtitle = editDesc.value.trim();
        if (editYear) projects[existingIdx].year = editYear.value.trim();
        if (editClient) projects[existingIdx].client = editClient.value.trim();
        if (editRole) projects[existingIdx].role = editRole.value.trim();
        if (editToolkit) projects[existingIdx].toolkit = editToolkit.value.trim();
        
        try {
          localStorage.setItem('mihal_projects_cms_v5', JSON.stringify(projects));
          if (EDIT_MODE) fetch('./save-projects', {
            method: 'POST',
            body: JSON.stringify(projects),
            headers: {'Content-Type': 'application/json'}
          }).catch(()=>{});
        } catch(e) {}
      }
    };
    
    [editTitle, editDesc, editYear, editClient, editRole, editToolkit].forEach(field => {
      if(field) {
        field.addEventListener('input', () => {
          clearTimeout(modalAutoSaveTimer);
          modalAutoSaveTimer = setTimeout(saveSilent, 800);
        });
      }
    });

    setTimeout(() => {
      if (editTitle) editTitle.focus();
    }, 100);
  }

  function closeCardEditor() {
    if (cardEditorModal) cardEditorModal.classList.remove('active');
  }

  if (cardEditorCloseBtn) cardEditorCloseBtn.addEventListener('click', closeCardEditor);
  if (cardEditorCancelBtn) cardEditorCancelBtn.addEventListener('click', closeCardEditor);

  const addProjectBtn = document.getElementById('add-project-btn');
  if (addProjectBtn) {
    addProjectBtn.addEventListener('click', () => {
      openCardEditor({
        id: `work-${Date.now()}`,
        title: '',
        subtitle: '',
        category: 'Motion & Screen Graphics',
        catTag: 'motion',
        year: '',
        client: '',
        toolkit: '',
        role: '',
        asset: '',
        videoAsset: '',
        description: ''
      }, true);
    });
  }

  // INSTANT FILE PICK AUTO-UPLOAD HOOKS
  if (modalFileImg) {
    modalFileImg.addEventListener('change', async () => {
      if (modalFileImg.files && modalFileImg.files[0]) {
        const file = modalFileImg.files[0];
        showToast(`Uploading cover picture ${file.name}...`);
        const savedPath = await uploadFileToSiteFolder(file);
        editProjectAssetUrl.value = savedPath;
        showToast(`✓ Static image uploaded & saved to ${savedPath}!`);
      }
    });
  }

  if (modalFileVid) {
    modalFileVid.addEventListener('change', async () => {
      if (modalFileVid.files && modalFileVid.files[0]) {
        const file = modalFileVid.files[0];
        showToast(`Uploading motion video ${file.name}...`);
        const savedPath = await uploadFileToSiteFolder(file);
        editProjectVideoUrl.value = savedPath;
        showToast(`✓ Motion video uploaded & saved to ${savedPath}!`);
      }
    });
  }

  if (modalFileGallery) {
    modalFileGallery.addEventListener('change', async () => {
      if (modalFileGallery.files && modalFileGallery.files.length > 0) {
        const files = Array.from(modalFileGallery.files);
        showToast(`Uploading ${files.length} gallery media files...`);
        const uploadedPaths = [];
        for (const file of files) {
          const saved = await uploadFileToSiteFolder(file);
          if (saved) uploadedPaths.push(saved);
        }
        if (editGalleryUrls && uploadedPaths.length > 0) {
          const existing = editGalleryUrls.value.trim() ? editGalleryUrls.value.split(',').map(s=>s.trim()).filter(Boolean) : [];
          const combined = Array.from(new Set([...existing, ...uploadedPaths]));
          editGalleryUrls.value = combined.join(', ');
        }
        showToast(`✓ Uploaded & attached ${uploadedPaths.length} gallery files!`);
      }
    });
  }

  // CLEAR MEDIA BUTTON LISTENERS
  const clearVideoBtn = document.getElementById('clear-video-btn');
  const clearImageBtn = document.getElementById('clear-image-btn');
  const clearGalleryBtn = document.getElementById('clear-gallery-btn');

  if (clearVideoBtn) {
    clearVideoBtn.addEventListener('click', () => {
      if (editProjectVideoUrl) editProjectVideoUrl.value = '';
      if (modalFileVid) modalFileVid.value = '';
      showToast('🗑️ Cleared motion video');
    });
  }

  if (clearImageBtn) {
    clearImageBtn.addEventListener('click', () => {
      if (editProjectAssetUrl) editProjectAssetUrl.value = '';
      if (modalFileImg) modalFileImg.value = '';
      showToast('🗑️ Cleared cover image');
    });
  }

  if (clearGalleryBtn) {
    clearGalleryBtn.addEventListener('click', () => {
      if (editGalleryUrls) editGalleryUrls.value = '';
      if (modalFileGallery) modalFileGallery.value = '';
      showToast('🗑️ Cleared gallery animations');
    });
  }

  function detectFileAspectRatio(file) {
    return new Promise((resolve) => {
      if (!file) return resolve('3/4');

      let resolved = false;
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve('16/9'); // Default fallback if metadata takes long
        }
      }, 1000);

      const isVideo = file.type.startsWith('video/') || isVideoUrl(file.name);
      if (isVideo) {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutTimer);
          window.URL.revokeObjectURL(video.src);
          const w = video.videoWidth || 16;
          const h = video.videoHeight || 9;
          if (w > h * 1.25) resolve('16/9');
          else if (h > w * 1.1) resolve('9/16');
          else resolve('1/1');
        };
        video.onerror = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutTimer);
          resolve('9/16');
        };
        video.src = URL.createObjectURL(file);
      } else {
        const img = new Image();
        img.onload = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutTimer);
          window.URL.revokeObjectURL(img.src);
          const w = img.naturalWidth || 16;
          const h = img.naturalHeight || 9;
          if (w > h * 1.25) resolve('16/9');
          else if (h > w * 1.1) resolve('9/16');
          else resolve('1/1');
        };
        img.onerror = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutTimer);
          resolve('3/4');
        };
        img.src = URL.createObjectURL(file);
      }
    });
  }

  // SAVE PROJECT SETUP & MEDIA PERMANENTLY TO DISK
  let isSavingProject = false;

  async function handleSaveProjectSetup() {
    if (isSavingProject) return;
    isSavingProject = true;

    if (saveCardSubmitBtn) {
      saveCardSubmitBtn.disabled = true;
      saveCardSubmitBtn.textContent = 'SAVING...';
    }

    try {
      const pid = editProjectId.value || `project-${Date.now()}`;
      const catVal = editCategory.value || 'motion';
      const catLabel = catVal === 'motion' ? 'Motion & Screen Graphics' : catVal === 'branding' ? 'Branding & Typography' : 'Art Direction & Visual Projects';
      
      let assetUrl = editProjectAssetUrl.value.trim();
      let videoUrl = editProjectVideoUrl.value.trim();
      let detectedAspect = '';

      // Only upload if URL is empty AND a file was selected in input
      if (!videoUrl && modalFileVid && modalFileVid.files && modalFileVid.files[0]) {
        const file = modalFileVid.files[0];
        showToast(`Saving motion video ${file.name}...`);
        detectedAspect = await detectFileAspectRatio(file);
        videoUrl = await uploadFileToSiteFolder(file);
        editProjectVideoUrl.value = videoUrl;
      } else if (modalFileVid && modalFileVid.files && modalFileVid.files[0]) {
        detectedAspect = await detectFileAspectRatio(modalFileVid.files[0]);
      }

      if (!assetUrl && modalFileImg && modalFileImg.files && modalFileImg.files[0]) {
        const file = modalFileImg.files[0];
        showToast(`Saving cover image ${file.name}...`);
        if (!detectedAspect) detectedAspect = await detectFileAspectRatio(file);
        assetUrl = await uploadFileToSiteFolder(file);
        editProjectAssetUrl.value = assetUrl;
      } else if (!detectedAspect && modalFileImg && modalFileImg.files && modalFileImg.files[0]) {
        detectedAspect = await detectFileAspectRatio(modalFileImg.files[0]);
      }

      const titleVal = editTitle.value.trim();
      const descVal = editDesc.value.trim();
      const yearVal = editYear ? editYear.value.trim() : '';
      const clientVal = editClient ? editClient.value.trim() : '';
      const roleVal = editRole ? editRole.value.trim() : '';
      const toolkitVal = editToolkit ? editToolkit.value.trim() : '';

      const existingProj = projects.find(p => p.id === pid);
      const existingAspect = (existingProj && existingProj.aspectRatio) ? existingProj.aspectRatio : '3/4';
      const finalAspect = detectedAspect || existingAspect;

      let galleryList = [];
      if (editGalleryUrls && editGalleryUrls.value.trim()) {
        galleryList = editGalleryUrls.value.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (videoUrl && !galleryList.includes(videoUrl)) galleryList.unshift(videoUrl);
      if (assetUrl && !galleryList.includes(assetUrl)) galleryList.push(assetUrl);
      galleryList = Array.from(new Set(galleryList));

      if (!videoUrl && galleryList.length > 0) {
        const firstVid = galleryList.find(url => isVideoUrl(url));
        if (firstVid) {
          videoUrl = firstVid;
        }
      }

      const updatedData = {
        id: pid,
        title: titleVal,
        subtitle: descVal,
        category: catLabel,
        catTag: catVal,
        year: yearVal,
        client: clientVal,
        role: roleVal,
        toolkit: toolkitVal,
        asset: assetUrl,
        videoAsset: videoUrl,
        gallery: galleryList,
        isVideo: Boolean(videoUrl && isVideoUrl(videoUrl)),
        aspectRatio: finalAspect,
        description: descVal
      };

      if (isNewProjectMode) {
        if (window.insertAfterProjectId) {
          const afterIdx = projects.findIndex(p => p.id === window.insertAfterProjectId);
          if (afterIdx !== -1) {
            projects.splice(afterIdx + 1, 0, updatedData);
          } else {
            projects.push(updatedData);
          }
          window.insertAfterProjectId = null;
        } else {
          projects.push(updatedData);
        }
      } else {
        const idx = projects.findIndex(p => p.id === pid);
        if (idx !== -1) {
          projects[idx] = updatedData;
        } else {
          projects.push(updatedData);
        }
      }

      await saveProjectsData();
      renderPortfolio();
      closeCardEditor();
      showToast(`💾 Saved "${titleVal}" permanently to website!`);
    } catch (err) {
      console.error('[SAVE ERROR]', err);
      showToast(`⚠️ Save error: ${err.message}`);
    } finally {
      isSavingProject = false;
      if (saveCardSubmitBtn) {
        saveCardSubmitBtn.disabled = false;
        saveCardSubmitBtn.textContent = 'SAVE PERMANENTLY';
      }
    }
  }

  if (cardEditorForm) {
    cardEditorForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleSaveProjectSetup();
    });
  }

  if (saveCardSubmitBtn) {
    saveCardSubmitBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await handleSaveProjectSetup();
    });
  }

  // DELETE WORK ONLY WHEN USER EXPLICITLY CLICKS DELETE BUTTON
  if (deleteCurrentProjectBtn) {
    deleteCurrentProjectBtn.addEventListener('click', async () => {
      const pid = editProjectId.value;
      if (confirm('Are you sure you want to permanently delete this project card from your website?')) {
        projects = projects.filter(p => p.id !== pid);
        await saveProjectsData();
        renderPortfolio();
        closeCardEditor();
        showToast('🗑 Project deleted from website.');
      }
    });
  }

  // ------------------------------------------------------------------------
  // 5. MAIN BIG SHOWREEL PLAYER CONTROLLER (INSTANT AUTOPLAY ON PAGE LOAD)
  // ------------------------------------------------------------------------
  const mainVideo = document.getElementById('main-showreel');
  const muteBtn = document.getElementById('mute-btn');
  const userVideoInput = document.getElementById('user-video-input');
  const fullscreenReelBtn = document.getElementById('fullscreen-reel-btn');
  const showreelWrapper = document.getElementById('showreel-wrapper');

  if (mainVideo) {
    mainVideo.muted = true;
    mainVideo.defaultMuted = true;
    mainVideo.playsInline = true;
    mainVideo.style.cursor = 'pointer';

    // NOTE: hovering the showreel used to unmute it, so the trailer audio
    // started on its own just from moving the mouse. Sound is now opt-in only:
    // it plays exclusively when the 🔊 button is clicked.
    if (showreelWrapper) {
      showreelWrapper.addEventListener('mouseenter', () => {
        if (mainVideo.paused && !userManuallyPausedMainReel) {
          mainVideo.play().catch(() => {});
        }
      });
    }

    // CLICK MAIN SHOWREEL VIDEO -> TOGGLE AUDIO MUTE/UNMUTE
    mainVideo.addEventListener('click', (e) => {
      e.stopPropagation();
      mainVideo.muted = !mainVideo.muted;
      paintReelSound(muteBtn, mainVideo.muted);
    });
  }

  if (muteBtn && mainVideo) {
    paintReelSound(muteBtn, mainVideo.muted);
    // whatever mutes or unmutes the reel, the icon follows the video itself
    mainVideo.addEventListener('volumechange', () => paintReelSound(muteBtn, mainVideo.muted));

    // Touch screens have no hover: a tap on the reel shows the icon for a
    // moment, then it fades out again (CSS does the fading).
    const reelFrame = muteBtn.closest('.reel-frame');
    let soundIconTimer = 0;
    if (reelFrame) {
      reelFrame.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        reelFrame.classList.add('show-sound');
        clearTimeout(soundIconTimer);
        soundIconTimer = setTimeout(() => reelFrame.classList.remove('show-sound'), 2500);
      });
    }

    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mainVideo.muted = !mainVideo.muted;
      paintReelSound(muteBtn, mainVideo.muted);
    });
  }

  if (fullscreenReelBtn && showreelWrapper) {
    fullscreenReelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        showreelWrapper.requestFullscreen().catch(err => {
          showToast(`Fullscreen error: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    });
  }

  if (userVideoInput && mainVideo) {
    userVideoInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        // INSTANT LOCAL PREVIEW WITH BLOB URL
        const localBlobUrl = URL.createObjectURL(file);
        mainVideo.src = localBlobUrl;
        mainVideo.muted = true;
        mainVideo.load();
        userManuallyPausedMainReel = false;
        mainVideo.play().catch(() => {});
        paintReelSound(muteBtn, true);
        showToast(`▶ Loaded ${file.name} to Showreel! Saving to site disk...`);

        // BACKGROUND DISK SAVE
        const savedPath = await uploadFileToSiteFolder(file, 'showreel.mp4');
        const showreelCard = projects.find(p => p.id === 'featured-showreel-card');
        if (showreelCard) {
          showreelCard.videoAsset = 'esset/showreel.mp4';
          showreelCard.isVideo = true;
          await saveProjectsData();
          renderPortfolio();
        }
        showToast(`✓ Showreel saved permanently (${savedPath})!`);
      }
    });
  }

  // ------------------------------------------------------------------------
  // 6. DETAIL VIEW MODAL (STRICT PLAY / PAUSE USER CONTROL)
  // ------------------------------------------------------------------------
  const modalOverlay = document.getElementById('project-modal');
  const modalMediaWrapper = document.getElementById('modal-media-wrapper');

  let currentModalProject = null;

  async function handleDropFilesInsideModal(files, projData) {
    if (!files || files.length === 0 || !projData) return;

    showToast(`📥 מעלה ${files.length} קובץ/קבצים לגלריית הפרויקט...`);

    const uploadedPaths = [];
    for (const file of files) {
      try {
        const savedPath = await uploadFileToSiteFolder(file);
        if (savedPath) {
          uploadedPaths.push(savedPath);
        }
      } catch (err) {
        console.error('Modal upload error:', file.name, err);
      }
    }

    if (uploadedPaths.length === 0) {
      showToast('⚠️ העלאת הקבצים נכשלה. אנא נסה שנית.');
      return;
    }

    let currentItems = [];
    if (Array.isArray(projData.gallery) && projData.gallery.length > 0) {
      currentItems = [...projData.gallery];
    } else {
      if (projData.videoAsset) currentItems.push(projData.videoAsset);
      if (projData.asset && !currentItems.includes(projData.asset)) currentItems.push(projData.asset);
    }

    uploadedPaths.forEach(p => {
      if (!currentItems.includes(p)) {
        currentItems.push(p);
      }
    });

    projData.gallery = Array.from(new Set(currentItems.filter(Boolean)));

    // Ensure outside cover exists if it was empty
    if (!projData.videoAsset && !projData.asset && projData.gallery.length > 0) {
      const first = projData.gallery[0];
      if (isVideoUrl(first)) {
        projData.videoAsset = first;
        projData.isVideo = true;
      } else {
        projData.asset = first;
        projData.isVideo = false;
      }
    }

    const pIdx = projects.findIndex(p => p.id === projData.id);
    if (pIdx !== -1) {
      projects[pIdx] = { ...projData };
    }

    await saveProjectsData();
    renderPortfolio();
    openProjectModal(projData);
    showToast(`✨ נוספו ${uploadedPaths.length} קבצים בהצלחה לגלריה הפנימית של הפרויקט!`);
  }

  // ------------------------------------------------------------------------
  // PER-PROJECT DRAWN GLYPH
  // Replaces the one fixed logo in the project sidebar. Each drawing is built
  // from the marks in the "עדת המלאכים הגדולה" booklet — pin-loops on stalks,
  // chevron rows, the T/cross notation — so every project opens with a
  // different small ink drawing. Chosen by project id, so a given project
  // always keeps its own mark instead of shuffling on each visit.
  // ------------------------------------------------------------------------
  // Each entry is ONE emblem lifted from the book "עדת המלאכים הגדולה" —
  // a thorned tendril, a barbed disc, a spined beast, a handled vessel, a
  // stepped ramp, a veined pod. Deliberately not reduced to plain chevrons or
  // loops: in the book every central image is a single creature-like figure
  // with character, and that is what the sidebar mark should read as.
  // ------------------------------------------------------------------------
  // THE MARK AT THE HEAD OF A PROJECT
  // One solid mass per emblem — round lobes on pinched waists, no stroke and
  // no interior linework. The previous set was drawn in hairlines, which the
  // page's scan grain cannot sit on: at this size the texture landed between
  // the lines instead of on the mark. A filled silhouette carries it.
  // Traversed in one direction throughout, so nonzero unions the overlaps;
  // the pierced ones carry a reverse-wound centre, which is the only thing
  // that reads as a hole under that rule.
  // ------------------------------------------------------------------------
  // THE MARK AT THE HEAD OF A PROJECT
  // Pulled out of the book pages one by one — not a style borrowed from them
  // but the things actually drawn on them, each reduced to a single filled
  // silhouette. The outlines are deliberately off: every point carries a
  // seeded wobble and the corners are left hard, so the shape is a drawn one
  // before #glyph-grunge touches it. One direction of travel throughout, so
  // nonzero unions the parts; anything meant to read as a hole (the door,
  // the marks on the tag) is wound the other way.
  // ------------------------------------------------------------------------
  // THE MARK AT THE HEAD OF A PROJECT
  // Pulled out of the book pages one by one — not a style borrowed from them
  // but the things actually drawn on them, each reduced to a single filled
  // silhouette. The outlines are deliberately off: every point carries a
  // seeded wobble and the corners are left hard, so the shape is a drawn one
  // before #glyph-grunge touches it.
  //
  // Winding, measured rather than assumed: the body outlines run clockwise
  // and a plain drawn bar comes out counter-clockwise, so under nonzero it is
  // the PLAIN bar that subtracts — that is what cuts the door in the house,
  // the marks in the tag, the bands in the lantern. A cut that reaches past
  // the edge of the shape does not subtract at all; it paints itself in.
  //
  // Twenty-two of them for twenty works, so no two projects carry the same
  // mark. Past twenty-two the list wraps and repeats begin.
  // ------------------------------------------------------------------------
  // THE MARK AT THE HEAD OF A PROJECT
  // Traced off the book pages one at a time — the things actually drawn on
  // them, each reduced to a single filled silhouette. Every point carries a
  // seeded wobble and the corners are left hard, so the shape is a drawn one
  // before #glyph-grunge touches it.
  //
  // Winding is forced rather than inherited: the generator measures each
  // ring's signed area and turns it clockwise to fill or counter-clockwise
  // to cut. That is what opens the door in the hut, the slits in the mask,
  // the cracks in the boulder and the fingers in the coat. It was left to
  // chance twice and silently filled the holes in both times. A cut that
  // reaches past the edge of its shape still does not subtract — under
  // nonzero it paints itself back in.
  // ------------------------------------------------------------------------
  const PROJECT_GLYPHS = [
    { name: 'sprig',
      // p.4 — the barbed sprig, leaves paired up the stem
      d: `<path d="M -1.9 29.3 C -2.3 26.5, -4.7 -23.9, -4.7 -26.7
         C -4.7 -29.5, -2.2 -29.8, -1.8 -27 C -1.4 -24.1, 2.9 26.9, 2.9 29.7
         C 2.9 32.6, -1.5 32.1, -1.9 29.3 Z M -1.3 -24.1
         C -1 -24.6, -4.2 -31, -5.8 -32.3 C -7.4 -33.5, -13.2 -33.5, -13.3 -33.3
         C -13.5 -33.1, -11.8 -28.1, -10.2 -26.8
         C -8.6 -25.6, -1.6 -23.7, -1.3 -24.1 Z M 0.9 -23.7
         C 1.2 -23.3, 8.2 -24.6, 9.9 -25.9 C 11.6 -27.3, 13.6 -33.7, 13.4 -33.8
         C 13.2 -34, 6.7 -32.5, 5 -31.1 C 3.4 -29.8, 0.5 -24.1, 0.9 -23.7 Z
         M -1 -14.2 C -0.8 -14.6, -4.8 -21.4, -6.9 -22.8
         C -9 -24.3, -16.6 -25.5, -16.7 -25.3
         C -16.8 -25.1, -12.3 -18.8, -10.3 -17.3
         C -8.2 -15.8, -1.3 -13.8, -1 -14.2 Z M 0.8 -14.8
         C 1 -14.4, 7.4 -16.5, 9.4 -18 C 11.3 -19.4, 15.5 -25.6, 15.4 -25.7
         C 15.3 -25.9, 8.6 -24.6, 6.7 -23.1 C 4.7 -21.6, 0.6 -15.2, 0.8 -14.8 Z
         M -0.5 -4.5 C -0.1 -4.8, -4.9 -11.4, -7 -13
         C -9.2 -14.7, -16.3 -16.8, -16.5 -16.7
         C -16.6 -16.6, -13.7 -11, -11.5 -9.3 C -9.4 -7.7, -0.8 -4.2, -0.5 -4.5 Z
         M 0.2 -4.4 C 0.6 -4, 8.7 -7.5, 11 -9.3
         C 13.3 -11.1, 17.4 -17.7, 17.3 -17.8 C 17.1 -18, 9 -15.9, 6.7 -14.1
         C 4.5 -12.3, -0.1 -4.7, 0.2 -4.4 Z M -0.3 5 C -0 4.7, -4.7 -1.8, -6.9 -3.3
         C -9.2 -4.9, -17.2 -6.9, -17.4 -6.8 C -17.5 -6.7, -13.2 -0.8, -11 0.8
         C -8.7 2.4, -0.6 5.3, -0.3 5 Z M 1.5 5.7 C 1.8 6.1, 9.8 2.8, 12.1 1
         C 14.4 -0.8, 18.8 -7.6, 18.7 -7.7 C 18.6 -7.9, 10.5 -5.3, 8.2 -3.5
         C 5.9 -1.7, 1.2 5.4, 1.5 5.7 Z M -0.5 14.9 C -0.3 14.6, -6.3 9.3, -8.6 7.8
         C -10.9 6.4, -17.6 3.7, -17.7 3.8 C -17.8 4, -13.7 10.4, -11.4 11.9
         C -9.2 13.3, -0.7 15.2, -0.5 14.9 Z M 1.3 15.4
         C 1.6 15.7, 9.6 13.8, 11.8 12.2 C 13.9 10.7, 17.5 3.7, 17.4 3.5
         C 17.3 3.4, 9.8 5.8, 7.7 7.4 C 5.5 8.9, 0.9 15, 1.3 15.4 Z M -2.8 -23.2
         C -2.6 -23.5, -2.8 -29.5, -3.6 -30.8 C -4.4 -32.1, -8.6 -33.3, -8.7 -33.1
         C -8.8 -33, -8.1 -27.7, -7.3 -26.4 C -6.5 -25.1, -3.1 -22.8, -2.8 -23.2 Z
         M 0.4 -23.2 C 0.7 -23, 4.5 -26.1, 5.3 -27.5
         C 6 -28.9, 6.2 -33.5, 6.1 -33.6 C 5.9 -33.7, 2.3 -31.3, 1.5 -29.9
         C 0.8 -28.5, 0.1 -23.4, 0.4 -23.2 Z" />` },

    { name: 'cloths',
      // p.15 — the drapes off a line, tapering and all leaning one way
      d: `<path d="M -31.3 -29.5 C -28.1 -29.7, 28.8 -29.4, 32 -29.2
         C 35.1 -29, 34.8 -25.7, 31.6 -25.5 C 28.4 -25.3, -28.8 -25.5, -31.9 -25.7
         C -35.1 -25.9, -34.5 -29.4, -31.3 -29.5 Z M -24.9 -26.9
         C -24.6 -27.6, -14.7 -27.4, -14.1 -26.7 C -13.5 -26, -11 -14.6, -11.5 -10
         C -12.1 -5.4, -18.3 16.1, -19.3 19.3 C -20.4 22.5, -24.2 28.7, -24.4 28.7
         C -24.5 28.7, -24.9 21.3, -24.8 18.8 C -24.7 16.3, -22.4 -4.1, -22.4 -8.6
         C -22.4 -13.2, -25.3 -26.1, -24.9 -26.9 Z M -12.6 -26.8
         C -12.2 -27.5, -2.2 -26.2, -1.7 -25.5 C -1.2 -24.9, 0 -15.9, -0.7 -10.8
         C -1.5 -5.6, -8.5 22, -9.6 25.9 C -10.7 29.7, -13.9 35.7, -14 35.6
         C -14.1 35.5, -14.5 26.1, -14.3 23.2 C -14.1 20.3, -11.3 -3.5, -11.1 -8.5
         C -10.9 -13.5, -13 -26.1, -12.6 -26.8 Z M 0.1 -26.6
         C 0.5 -27.4, 10.3 -27.5, 10.8 -26.8 C 11.4 -26.2, 14.5 -14.9, 13.9 -10.6
         C 13.3 -6.4, 5.8 12.6, 4.7 15.6 C 3.6 18.7, 0.9 26, 0.8 26
         C 0.7 26, -0.4 17.7, -0.3 15.3 C -0.2 12.9, 2.2 -5.4, 2.2 -9.6
         C 2.2 -13.8, -0.3 -25.9, 0.1 -26.6 Z M 12.3 -25.3
         C 12.7 -26.1, 24 -27, 24.6 -26.4 C 25.2 -25.8, 26.5 -15.2, 25.6 -10.4
         C 24.7 -5.6, 16.7 17.7, 15.5 21.3 C 14.3 24.9, 11.3 32.7, 11.2 32.7
         C 11.1 32.7, 10.6 23.2, 10.9 20.5 C 11.2 17.7, 15.3 -3.7, 15.5 -8.3
         C 15.6 -12.9, 11.9 -24.6, 12.3 -25.3 Z" />` },

    { name: 'house',
      // p.22 — the hut alone, and the dashes down its right side
      d: `<path d="M -8.3 -28.7 C -7.2 -28.9, 16.6 -18.9, 17.2 -17.9
         C 17.9 -16.8, 18 12.5, 17.5 13.5 C 16.9 14.5, -4.1 21.3, -5.2 21.2
         C -6.3 21.2, -26.1 12.4, -26.6 11.6 C -27.2 10.8, -28.2 -10.4, -27.7 -11.4
         C -27.3 -12.4, -9.5 -28.6, -8.3 -28.7 Z M -10.5 -28.2
         C -10.4 -26.9, -6.4 -3.1, -6.1 -1.9 C -5.7 -0.7, -3.4 -2.5, -3.5 -3.8
         C -3.6 -5.1, -7.5 -26.7, -7.9 -27.9
         C -8.2 -29.1, -10.6 -29.5, -10.5 -28.2 Z M -27 -9.7
         C -26 -9.2, -7.1 -1.8, -5.9 -1.6 C -4.8 -1.4, -3.1 -4.7, -4.2 -5.2
         C -5.2 -5.7, -25.5 -11.8, -26.6 -12 C -27.8 -12.2, -28.1 -10.3, -27 -9.7 Z
         M -20.2 16.6 C -20.1 16.8, -14.9 16.8, -14.7 16.5
         C -14.6 16.3, -13.3 3.3, -13.4 3.1 C -13.5 2.9, -21.8 4.1, -21.9 4.3
         C -22 4.6, -20.3 16.4, -20.2 16.6 Z M 26.1 -23.9
         C 26.5 -23.5, 29 -15.4, 29 -14.9 C 29.1 -14.5, 27.2 -14.5, 26.9 -14.9
         C 26.6 -15.3, 22.6 -22.8, 22.5 -23.2
         C 22.5 -23.7, 25.8 -24.3, 26.1 -23.9 Z M 31.9 -12.2
         C 32.1 -11.8, 33.1 -4.1, 33 -3.6 C 32.9 -3.1, 30.8 -1.5, 30.5 -1.9
         C 30.3 -2.3, 28.2 -10.6, 28.3 -11.1 C 28.3 -11.6, 31.7 -12.5, 31.9 -12.2 Z
         M 27 2.3 C 27.1 2.8, 26.1 10.3, 25.9 10.7
         C 25.7 11.1, 22.9 10.7, 22.9 10.2 C 22.8 9.8, 24 1.9, 24.3 1.5
         C 24.5 1.1, 27 1.9, 27 2.3 Z M 33.5 12.2 C 33.7 12.6, 33.6 19.2, 33.5 19.6
         C 33.3 20, 29.9 20.4, 29.7 20 C 29.4 19.7, 28.7 12.9, 28.9 12.5
         C 29.1 12.1, 33.2 11.9, 33.5 12.2 Z M 24.9 20.7
         C 25.2 21, 28.5 27.7, 28.5 28.1 C 28.5 28.5, 25.7 28.6, 25.4 28.3
         C 25 28, 22 22.6, 22 22.2 C 22 21.8, 24.6 20.4, 24.9 20.7 Z" />` },

    { name: 'strider',
      // p.15 — one of the striding figures
      d: `<path d="M -2.4 -29.5 C -1 -30.4, 4.5 -28.3, 5.4 -26.7
         C 6.2 -25.1, 4.7 -19.8, 3.3 -18.9 C 2 -18, -2.7 -19.2, -3.6 -20.7
         C -4.4 -22.3, -3.7 -28.6, -2.4 -29.5 Z M -5.5 -19.5
         C -4.2 -20.3, 5.7 -18.9, 7.1 -17.5 C 8.5 -16.1, 11.7 -4.7, 11.4 -2.6
         C 11 -0.5, 5.2 3.1, 3.7 3.6 C 2.3 4, -5.2 3.6, -6.2 2.7
         C -7.2 1.8, -8.2 -5.4, -8.2 -7.6 C -8.1 -9.8, -6.8 -18.7, -5.5 -19.5 Z
         M -7 -11.4 C -8.1 -11.6, -25.5 -20.1, -26.5 -20.8
         C -27.4 -21.4, -27 -23.7, -25.9 -23.5 C -24.8 -23.3, -5.5 -17, -4.5 -16.4
         C -3.6 -15.8, -5.9 -11.2, -7 -11.4 Z M 8.3 -15.5
         C 9.3 -15.2, 25.4 -5.9, 26.3 -5.3 C 27.2 -4.6, 27.2 -2.5, 26.2 -2.8
         C 25.3 -3.1, 8.5 -10.4, 7.6 -11 C 6.7 -11.6, 7.4 -15.8, 8.3 -15.5 Z
         M -1.8 4.6 C -2.3 6.1, -16.3 29.1, -17.2 30.3
         C -18.1 31.4, -20.8 29.4, -20.3 28 C -19.7 26.5, -7 2.9, -6.1 1.7
         C -5.2 0.6, -1.2 3.2, -1.8 4.6 Z M 8.9 2.5 C 9.6 3.8, 17.6 27.3, 17.9 28.7
         C 18.3 30.1, 16.6 31.9, 15.9 30.7 C 15.2 29.4, 3.9 5.2, 3.5 3.8
         C 3.2 2.4, 8.2 1.3, 8.9 2.5 Z" />` },

    { name: 'net',
      // p.17 — the net the tube weaves at the foot of the drawing
      d: `<path d="M -23 -26.7 C -22 -24.1, -9.3 22.9, -8.7 25.7
         C -8.1 28.4, -10.8 30, -11.8 27.5 C -12.8 24.9, -28 -22.6, -28.6 -25.3
         C -29.2 -28, -24 -29.2, -23 -26.7 Z M -8.4 -25.4
         C -8.9 -22.7, -22.2 23.6, -23.2 26.2 C -24.2 28.8, -29 28.7, -28.4 26.1
         C -27.9 23.4, -13.3 -24, -12.3 -26.5 C -11.3 -29.1, -7.8 -28, -8.4 -25.4 Z
         M -12.6 -27.4 C -11.6 -24.8, 3.1 22.7, 3.8 25.4
         C 4.4 28.1, 1.6 29, 0.6 26.5 C -0.4 23.9, -15.7 -23, -16.3 -25.7
         C -17 -28.4, -13.6 -30, -12.6 -27.4 Z M 3.7 -25.4
         C 3.2 -22.8, -10.7 23.9, -11.6 26.5 C -12.6 29, -16 27.9, -15.5 25.3
         C -15 22.6, -2.1 -23.6, -1.1 -26.1 C -0.1 -28.6, 4.2 -28, 3.7 -25.4 Z
         M -0.1 -27 C 0.9 -24.4, 14.7 23.2, 15.3 26 C 16 28.7, 13.5 30.1, 12.5 27.5
         C 11.5 24.9, -4.2 -23.3, -4.8 -26 C -5.4 -28.7, -1.1 -29.6, -0.1 -27 Z
         M 15.8 -25.2 C 15.2 -22.5, 0.4 25, -0.5 27.5 C -1.5 30, -3.8 27.7, -3.1 25
         C -2.5 22.2, 11.3 -24.9, 12.3 -27.4 C 13.2 -29.9, 16.4 -28, 15.8 -25.2 Z
         M 11.5 -27.2 C 12.5 -24.8, 27.3 22.3, 28 25
         C 28.6 27.7, 25.3 28.8, 24.3 26.3 C 23.3 23.8, 8.5 -22, 7.8 -24.6
         C 7.2 -27.3, 10.4 -29.7, 11.5 -27.2 Z M 28.7 -25.1
         C 28.1 -22.5, 13.4 24.4, 12.4 27 C 11.4 29.5, 8.1 28.6, 8.7 25.9
         C 9.2 23.3, 22.7 -23.7, 23.7 -26.2 C 24.7 -28.8, 29.3 -27.8, 28.7 -25.1 Z
         M -29.3 -20.5 C -26.3 -20.9, 26.7 -24, 29.6 -23.9
         C 32.6 -23.9, 33.6 -19.2, 30.6 -18.8
         C 27.7 -18.4, -26.5 -15.8, -29.5 -15.9
         C -32.4 -16, -32.2 -20.1, -29.3 -20.5 Z M -29.7 13.8
         C -26.8 13.7, 26.7 17, 29.6 17.4 C 32.6 17.7, 32.7 20.9, 29.7 20.9
         C 26.8 20.9, -26.7 17.9, -29.6 17.5 C -32.6 17.1, -32.7 13.8, -29.7 13.8 Z" />` },

    { name: 'tag',
      // p.27 — a tag off the labelled boulder, marks cut through it
      d: `<path d="M -22.8 -16.7 C -21.7 -17.8, 22.4 -24.4, 23.6 -23.6
         C 24.8 -22.9, 27.3 12.2, 26.2 13.3 C 25.1 14.4, -18.5 21.6, -19.7 20.8
         C -20.9 20.1, -23.9 -15.6, -22.8 -16.7 Z M -14.1 -9
         C -14.3 -8.5, -15.4 1.3, -15.3 2 C -15.2 2.6, -12.3 4.6, -12.1 4
         C -11.8 3.4, -10.2 -8.6, -10.3 -9.2 C -10.4 -9.9, -13.8 -9.6, -14.1 -9 Z
         M -5.7 -13.7 C -5.8 -12.9, -6.9 1.1, -6.8 2 C -6.7 2.9, -4.1 4.3, -3.9 3.6
         C -3.7 2.8, -3.2 -12.6, -3.2 -13.5 C -3.3 -14.4, -5.5 -14.4, -5.7 -13.7 Z
         M 2.9 -6.7 C 2.8 -6.2, 5.2 2.6, 5.5 3 C 5.8 3.4, 9.3 2.3, 9.4 1.8
         C 9.4 1.3, 7.1 -6.6, 6.8 -7 C 6.4 -7.4, 3 -7.2, 2.9 -6.7 Z M -10.7 5.5
         C -10.9 6, -12.2 16.2, -12.2 16.8 C -12.2 17.4, -10.4 17.9, -10.2 17.4
         C -10 16.8, -7.9 6.5, -7.9 5.9 C -8 5.3, -10.5 4.9, -10.7 5.5 Z M 2.9 7.1
         C 2.8 7.5, 3 15.3, 3.1 15.8 C 3.2 16.2, 5.6 16.3, 5.7 15.9
         C 5.8 15.5, 5.1 8.1, 4.9 7.7 C 4.8 7.2, 3 6.7, 2.9 7.1 Z M 19.4 -21.1
         C 19.8 -21.7, 29.1 -29.6, 29.6 -30 C 30.2 -30.4, 31.7 -29, 31.3 -28.4
         C 30.9 -27.9, 22.3 -19.3, 21.7 -18.9 C 21.1 -18.6, 19 -20.6, 19.4 -21.1 Z" />` },

    { name: 'splay',
      // p.15 — the fan of bands thrown out from one point
      d: `<path d="M 23 10.2 C 20.7 10.3, -20.1 4.4, -22.3 3.7
         C -24.5 3, -23.5 -3.4, -21.2 -3.5 C -18.9 -3.6, 21.6 1.1, 23.8 1.7
         C 26 2.4, 25.3 10.1, 23 10.2 Z M 21.7 8.9
         C 19.7 8.1, -11.9 -11.6, -13.6 -13 C -15.2 -14.3, -13 -18.8, -11 -18
         C -9 -17.2, 24.4 1.4, 26 2.7 C 27.7 4, 23.7 9.7, 21.7 8.9 Z M 21.4 8
         C 20 6.7, -1.2 -19.7, -2.1 -21.4 C -3 -23.1, 1.7 -27, 3.1 -25.7
         C 4.5 -24.4, 25.3 2.5, 26.2 4.2 C 27.1 5.9, 22.8 9.3, 21.4 8 Z M 25.6 9.5
         C 23.8 10.4, -10.8 20.1, -12.8 20.3 C -14.8 20.6, -16.3 15.7, -14.5 14.8
         C -12.7 13.8, 21.4 2.4, 23.4 2.1 C 25.4 1.8, 27.4 8.6, 25.6 9.5 Z
         M 25.2 8.7 C 23.9 9.9, -2 27.3, -3.6 28 C -5.2 28.7, -7.3 23.8, -6 22.6
         C -4.7 21.3, 20.7 3.9, 22.3 3.2 C 23.9 2.5, 26.4 7.5, 25.2 8.7 Z
         M 15.6 5.9 C 14.2 4.7, -6.2 -21.3, -7.2 -22.8
         C -8.3 -24.4, -6.1 -26.4, -4.7 -25.2 C -3.3 -23.9, 19.7 0.9, 20.7 2.4
         C 21.7 4, 17 7.2, 15.6 5.9 Z" />` },

    { name: 'boulder',
      // p.27 — the boulder itself, split by its cracks
      d: `<path d="M -3.8 -30.1 C -1.7 -30.4, 13.9 -25, 15.8 -23.4
         C 17.8 -21.8, 25 -9.1, 25.6 -5.8 C 26.2 -2.5, 24.1 13.6, 22.6 15.9
         C 21.2 18.2, 6.1 28.1, 3.9 28.5 C 1.7 28.9, -13 24.2, -14.9 22.6
         C -16.8 21, -24.2 7.8, -24.6 4.5 C -25 1.1, -21.4 -15.1, -20 -17.4
         C -18.6 -19.7, -5.9 -29.7, -3.8 -30.1 Z M -3.5 -27.3
         C -3.4 -24.6, 0.1 24.1, 0.5 26.8 C 0.8 29.4, 3.5 28.5, 3.4 25.8
         C 3.4 23.1, -0.2 -24.7, -0.6 -27.3 C -0.9 -30, -3.5 -30, -3.5 -27.3 Z
         M -22.6 -4.6 C -20.5 -4.2, 19 -0.6, 21.1 -0.6
         C 23.3 -0.5, 23.5 -3.6, 21.3 -4 C 19.2 -4.4, -18.9 -8.4, -21.1 -8.4
         C -23.3 -8.4, -24.7 -5, -22.6 -4.6 Z M -15.1 18.1
         C -13.5 16.3, 13.5 -16.2, 14.9 -18 C 16.3 -19.9, 14.5 -20.5, 12.8 -18.7
         C 11.2 -16.9, -16.6 15.9, -18 17.8 C -19.3 19.6, -16.7 19.9, -15.1 18.1 Z
         M 17.2 16.7 C 15.8 14.9, -9.3 -15.4, -10.8 -17
         C -12.4 -18.6, -14.5 -17.9, -13.2 -16.1
         C -11.9 -14.3, 14.2 16.5, 15.7 18.2 C 17.2 19.8, 18.5 18.4, 17.2 16.7 Z" />` },

    { name: 'coat',
      // p.30 — the coat on its hanger, the fingers cut into the cloth
      d: `<path d="M -5.8 -34.8 C -4.3 -35.6, 4.4 -35.6, 5.8 -34.6
         C 7.1 -33.7, 8.6 -26.4, 8.2 -25.2 C 7.7 -23.9, 2.7 -23.3, 2.1 -23.9
         C 1.5 -24.4, 3.2 -29.1, 2.8 -29.8 C 2.4 -30.5, -0.4 -30.4, -1.2 -30
         C -2 -29.7, -3.2 -27, -3.9 -26.8 C -4.5 -26.6, -6.8 -27.4, -7 -28.3
         C -7.3 -29.2, -7.3 -34.1, -5.8 -34.8 Z M -22.2 -19
         C -19.9 -19.3, 20.7 -19.4, 22.9 -19.2 C 25 -19, 23.5 -14.9, 21.3 -14.6
         C 19.1 -14.4, -19.8 -14.1, -22 -14.3
         C -24.2 -14.6, -24.4 -18.8, -22.2 -19 Z M 2.8 -23.1
         C 3 -22.7, 3.7 -16.5, 3.5 -16.2 C 3.4 -15.9, -0.4 -16.1, -0.5 -16.5
         C -0.7 -16.9, -0.1 -24.3, 0 -24.6 C 0.2 -24.9, 2.7 -23.5, 2.8 -23.1 Z
         M 1.3 -9.9 C 4.8 -9.9, 15.9 -14.1, 17.3 -13.5
         C 18.8 -12.8, 25 -2, 25.5 1.2 C 25.9 4.4, 24.3 18, 22.2 21.1
         C 20.2 24.1, 7.9 30.9, 4.9 31.5 C 2 32.2, -10.7 30.5, -13 29.2
         C -15.4 28, -22.5 19.5, -23.7 16.3 C -24.9 13.1, -25.6 0.3, -25 -2.5
         C -24.5 -5.2, -19.2 -13.1, -17.7 -13.5 C -16.1 -13.9, -2.2 -10, 1.3 -9.9 Z
         M -9.6 25.4 C -9.2 24.2, -8.6 2.8, -8.8 1.6
         C -9 0.4, -13.5 -0.3, -13.8 0.9 C -14.2 2.1, -15.5 24.1, -15.3 25.3
         C -15 26.5, -9.9 26.6, -9.6 25.4 Z M -2.2 24.4
         C -1.9 23.4, -2.2 7.4, -2.4 6.5 C -2.6 5.6, -5.5 5.9, -5.8 6.8
         C -6.1 7.8, -8.7 24.8, -8.5 25.7 C -8.3 26.6, -2.5 25.3, -2.2 24.4 Z
         M 6.2 25.2 C 6.5 24, 6.9 2.3, 6.7 1 C 6.4 -0.2, 1.4 -0.6, 1.1 0.6
         C 0.8 1.8, 0.7 22.9, 0.9 24.2 C 1.2 25.4, 5.9 26.3, 6.2 25.2 Z M 14.4 24.3
         C 14.8 23.5, 14.7 8.6, 14.5 7.7 C 14.3 6.8, 10.4 5.4, 10 6.2
         C 9.7 7, 7.2 23.2, 7.4 24.1 C 7.6 25, 14 25.1, 14.4 24.3 Z" />` },

    { name: 'dart',
      // p.4 — the darts stacked down the left margin
      d: `<path d="M -30.3 -22.3 C -30.3 -23, 5.8 -35.6, 8.9 -35.7
         C 11.9 -35.9, 29.9 -25.6, 30 -25.1 C 30 -24.6, 11.2 -21.7, 9.7 -20.7
         C 8.2 -19.6, 9.3 -9, 7.3 -9.1 C 5.3 -9.2, -30.4 -21.7, -30.3 -22.3 Z
         M -30.8 -3.1 C -30.8 -3.7, 4.6 -14.8, 7.6 -14.9
         C 10.6 -15, 29.1 -6.3, 29.1 -5.9 C 29.1 -5.5, 9.7 -3.4, 8.3 -2.4
         C 6.9 -1.4, 10.3 9, 8.3 9 C 6.4 9, -30.8 -2.5, -30.8 -3.1 Z M -29.7 17.8
         C -29.7 17.3, 4.8 6.4, 7.7 6.2 C 10.7 6, 29.5 13.7, 29.5 14.1
         C 29.6 14.4, 10.6 17, 9.2 17.9 C 7.8 18.8, 10.7 27.6, 8.8 27.6
         C 6.8 27.6, -29.7 18.4, -29.7 17.8 Z" />` },

    { name: 'loop',
      // p.17 — the tube: two lobes, the fork across the stem, the ring
      d: `<path d="M -29.7 -29.2 C -28.5 -30.1, -15.5 -22.3, -12.2 -22.5
         C -8.9 -22.7, -2.8 -31, -1.3 -31 C 0.3 -31.1, 7.5 -23.5, 11.2 -23.3
         C 14.9 -23.2, 29.1 -30.5, 30.3 -29.5 C 31.5 -28.4, 27.7 -14, 25.3 -11.1
         C 23 -8.3, 13.8 -5.8, 10.2 -5.2 C 6.7 -4.6, -6.6 -4.8, -10.2 -5.4
         C -13.8 -6.1, -23.5 -9.1, -25.8 -11.9
         C -28 -14.7, -30.8 -28.3, -29.7 -29.2 Z M -15.3 -10.6
         C -13.1 -8.9, -2.8 -8.5, 0.2 -8.5 C 3.2 -8.5, 12.7 -9, 14.9 -10.7
         C 17.1 -12.5, 19.7 -23.1, 19.1 -23.5 C 18.4 -23.9, 10 -15.3, 7.6 -15
         C 5.3 -14.8, -0.1 -21.3, -1.4 -21.3 C -2.8 -21.4, -6.1 -15.4, -8.2 -15.6
         C -10.3 -15.7, -18.6 -23, -19.2 -22.5
         C -19.8 -22.1, -17.6 -12.2, -15.3 -10.6 Z M 2.4 -8.4
         C 2.8 -7.4, 2.9 11.8, 2.7 13 C 2.6 14.1, -0.7 15.3, -1.1 14.2
         C -1.4 13.2, -4.3 -6.3, -4.2 -7.4 C -4 -8.5, 2.1 -9.4, 2.4 -8.4 Z
         M -16.8 -16.7 C -15.2 -16.8, 14.3 -14.8, 15.9 -14.6
         C 17.6 -14.3, 17.7 -12.1, 16 -12 C 14.3 -11.8, -16.1 -11.9, -17.8 -12.1
         C -19.4 -12.4, -18.5 -16.6, -16.8 -16.7 Z M -3.6 11.1
         C -0.9 10.1, 15.9 13.8, 18.4 14.9 C 20.9 16, 26.6 22.6, 26.6 24.1
         C 26.6 25.6, 20.6 32.2, 18.6 32.8 C 16.7 33.5, 5.6 32.7, 2.9 31.9
         C 0.2 31.1, -7.9 26.9, -8.6 24.9 C -9.2 22.8, -6.3 12.1, -3.6 11.1 Z
         M -4 22.1 C -3.6 23.1, -0.2 27, 1.6 27.6 C 3.4 28.2, 12.7 28.4, 14.2 28
         C 15.8 27.7, 20.1 24.6, 20.2 23.9 C 20.2 23.1, 16.7 19.7, 14.9 19.3
         C 13 18.8, 0.1 17.8, -1.8 18.1 C -3.7 18.4, -4.3 21.2, -4 22.1 Z" />` },

    { name: 'hand',
      // p.30 — one of the dark hands under the garment
      d: `<path d="M -35.9 0.4 C -35.2 -0.5, -20.2 -2.8, -19.2 -2.2
         C -18.3 -1.6, -16.5 11.6, -17.2 12.4 C -17.9 13.2, -32.4 15, -33.4 14.4
         C -34.3 13.8, -36.6 1.2, -35.9 0.4 Z M -24.2 -1.1
         C -24.5 -3.9, -23.1 -12.4, -22 -14.5 C -21 -16.6, -14.9 -21.7, -13.7 -22.2
         C -12.5 -22.7, -9.7 -20.3, -7.6 -20.1 C -5.6 -19.8, 15.5 -18.6, 16.9 -18.4
         C 18.2 -18.3, 19.9 -16.7, 19.8 -16.5 C 19.7 -16.2, 16.8 -13.5, 15.4 -13.3
         C 14.1 -13.1, -5.7 -12.3, -7.3 -12.1 C -8.9 -11.8, -10.5 -10.2, -8.7 -10
         C -6.8 -9.9, 18.9 -10.1, 20.6 -9.9 C 22.3 -9.7, 25.3 -5.9, 25.3 -5.7
         C 25.4 -5.4, 23.4 -3.2, 21.7 -3 C 20 -2.9, -6.5 -3.4, -8.5 -3.2
         C -10.5 -3, -10.4 -0.5, -8.1 -0.2 C -5.8 0, 24.2 0.3, 26.1 0.5
         C 28 0.7, 29.6 3.1, 29.6 3.4 C 29.6 3.6, 28.1 5.5, 26.2 5.7
         C 24.3 5.9, -6.2 6.7, -8.5 6.9 C -10.8 7.1, -10.6 9, -8.7 9.2
         C -6.8 9.3, 18.8 9.5, 20.4 9.6 C 22.1 9.8, 24.2 12, 24.2 12.3
         C 24.2 12.5, 21.7 15.7, 20.1 15.9 C 18.5 16.1, -5.3 16.9, -7.6 17
         C -9.9 17, -13.4 17.1, -14.3 16.8 C -15.2 16.4, -17.9 14.6, -18.7 13.1
         C -19.5 11.6, -23.9 1.6, -24.2 -1.1 Z" />` },

    { name: 'mound',
      // p.4 — the grave: a low mound, its pole and the crossbar
      d: `<path d="M -30.2 30.7 C -30.3 29.8, -12.6 5, -11.4 3.6
         C -10.3 2.2, -3.8 -3, -2.6 -2.8 C -1.4 -2.6, 10.4 6.3, 11.7 7.6
         C 13.1 9, 30.6 28.9, 30.4 29.8 C 30.2 30.7, 9.2 33.6, 6 33.8
         C 2.9 33.9, -4.6 31.8, -7.6 31.6 C -10.6 31.3, -30 31.7, -30.2 30.7 Z
         M -4.5 -0.9 C -4.5 -2.5, -0.2 -30, 0.2 -31.5
         C 0.6 -32.9, 3.8 -31.7, 3.8 -30.1 C 3.8 -28.5, 0.6 -0.5, 0.2 0.9
         C -0.2 2.4, -4.5 0.7, -4.5 -0.9 Z M -9.9 -26.2
         C -9.1 -26.5, 6.7 -27.5, 7.6 -27.4 C 8.5 -27.3, 8.2 -25, 7.4 -24.7
         C 6.5 -24.4, -8.2 -22, -9.1 -22 C -9.9 -22.1, -10.8 -25.9, -9.9 -26.2 Z" />` },

    { name: 'rays',
      // p.15 — the rays running back from the rectangle
      d: `<path d="M 26.5 0.1 C 23.6 -1, -26.8 -25, -29.6 -26.4
         C -32.4 -27.8, -32.5 -29.4, -29.6 -28.3
         C -26.6 -27.2, 26.5 -6.2, 29.3 -4.7 C 32.1 -3.3, 29.5 1.2, 26.5 0.1 Z
         M 27.1 0.2 C 24.1 -0.4, -27.5 -14.5, -30.4 -15.3
         C -33.3 -16.2, -33.5 -17.8, -30.5 -17.2 C -27.5 -16.6, 26 -4.5, 28.8 -3.6
         C 31.7 -2.8, 30.1 0.8, 27.1 0.2 Z M 28.3 0.2
         C 25.4 0.2, -26.4 -3.9, -29.3 -4.3 C -32.2 -4.7, -31.9 -7.5, -29.1 -7.5
         C -26.2 -7.5, 25.3 -5, 28.2 -4.6 C 31 -4.2, 31.2 0.2, 28.3 0.2 Z
         M 28.5 0.5 C 25.6 0.9, -27.1 4.9, -30.1 5.1
         C -33.1 5.3, -33.6 4.5, -30.7 4 C -27.8 3.5, 25.5 -4.1, 28.5 -4.3
         C 31.5 -4.5, 31.4 -0, 28.5 0.5 Z M 28.1 0.4
         C 25.3 1.4, -27.5 14.7, -30.5 15.4 C -33.4 16.1, -33.7 14.7, -30.8 13.7
         C -28 12.8, 24.1 -3.3, 27 -4 C 30 -4.6, 31 -0.6, 28.1 0.4 Z M 29.7 0.5
         C 27 1.9, -25.9 24, -28.9 25.2 C -32 26.4, -34 25.1, -31.2 23.7
         C -28.4 22.2, 23.5 -2, 26.5 -3.2 C 29.6 -4.3, 32.5 -1, 29.7 0.5 Z" />` },

    { name: 'tapers',
      // p.15 — the row of ellipses running away to a point
      d: `<path d="M -28.4 -9 C -26.8 -8.9, -23.5 -2.2, -23.5 0.4
         C -23.4 3, -26.5 8.3, -28 8.2 C -29.6 8.1, -33.8 2.3, -33.9 -0.3
         C -33.9 -2.9, -29.9 -9.1, -28.4 -9 Z M -19.4 -8
         C -18.1 -8, -15 -3.1, -15 -0.8 C -14.9 1.4, -17.7 6.8, -19.1 6.8
         C -20.5 6.8, -24.2 1.4, -24.2 -0.8 C -24.3 -3.1, -20.8 -8, -19.4 -8 Z
         M -10.1 -6.1 C -9 -5.9, -6.1 -1.3, -6.2 0.7 C -6.2 2.7, -9.4 7.2, -10.4 7
         C -11.4 6.8, -13.1 1.2, -13 -0.8 C -13 -2.7, -11.1 -6.3, -10.1 -6.1 Z
         M -1.4 -4.4 C -0.4 -4.5, 2.5 -2.1, 2.5 -0.7 C 2.5 0.8, -0.4 5.2, -1.4 5.3
         C -2.3 5.4, -4 1.7, -4 0.2 C -4 -1.2, -2.3 -4.2, -1.4 -4.4 Z M 8.7 -3.9
         C 9.5 -3.9, 10.4 -0.4, 10.4 0.9 C 10.3 2.2, 9.1 4.9, 8.4 4.9
         C 7.6 4.9, 5.5 2, 5.5 0.7 C 5.6 -0.7, 8 -4, 8.7 -3.9 Z M 16.1 -3.9
         C 16.6 -4.1, 18.5 -1.7, 18.6 -0.6 C 18.7 0.5, 17.3 3.3, 16.8 3.5
         C 16.3 3.6, 15.5 1.7, 15.4 0.6 C 15.3 -0.5, 15.7 -3.7, 16.1 -3.9 Z
         M 25.2 -1.8 C 25.6 -1.8, 26.9 -0.8, 27 -0.4 C 27 0.1, 25.9 1.2, 25.5 1.2
         C 25 1.2, 24.1 -0.2, 24 -0.6 C 24 -1.1, 24.7 -1.9, 25.2 -1.8 Z" />` },

    { name: 'ribbon',
      // p.4 — the ribbon doubling back on itself
      d: `<path d="M -29.6 25.5 C -30.2 25.2, -27.1 6.1, -24.4 2.1
         C -21.6 -1.9, -10.3 -6.7, -6.1 -8.7 C -1.8 -10.8, 9.6 -13.2, 12.2 -15.4
         C 14.7 -17.6, 14.4 -26.2, 15.8 -27.4 C 17.1 -28.7, 27.3 -30.9, 28.1 -30.2
         C 28.8 -29.5, 31.1 -16, 30.4 -13.5 C 29.7 -11.1, 22.9 -3.4, 19.5 -1
         C 16.1 1.4, 4 5, 1.3 7.1 C -1.3 9.3, -3.8 15.8, -3.4 17.5
         C -2.9 19.2, 5.6 23.4, 5.8 24.3 C 6 25.3, 1.2 31.1, -0.2 31.3
         C -1.6 31.6, -13.3 29.6, -14.9 28.7 C -16.5 27.8, -19.4 22.7, -19.7 20.5
         C -19.9 18.2, -16.3 5.8, -17.5 6.4 C -18.6 7, -29.1 25.9, -29.6 25.5 Z" />` },

    { name: 'shoes',
      // p.30 — the pair of shoes set down beside it
      d: `<path d="M -26.4 -18.8 C -25.2 -20, -9.6 -20.9, -8.2 -19.9
         C -6.7 -18.9, -4.9 -6.7, -4.6 -4.4 C -4.2 -2.1, -2.9 7, -3.7 7.7
         C -4.6 8.5, -19.6 11.3, -20.8 10.7 C -22 10.2, -26.5 -0.2, -27 -2.7
         C -27.5 -5.2, -27.7 -17.7, -26.4 -18.8 Z M -23.1 -10.1
         C -22.5 -9.9, -10.3 -11.5, -9.7 -11.7 C -9 -11.9, -8.9 -14, -9.6 -14.1
         C -10.3 -14.3, -22.2 -15, -22.9 -14.8
         C -23.5 -14.6, -23.8 -10.2, -23.1 -10.1 Z M 1.6 -12.3
         C 2.7 -13.4, 16 -14.1, 17.3 -13.2 C 18.7 -12.4, 21.7 -1.7, 22.2 0.5
         C 22.7 2.7, 24.4 12.6, 23.6 13.3 C 22.8 14, 7.7 15.1, 6.6 14.5
         C 5.4 14, 1.2 5.3, 0.8 3.1 C 0.4 0.8, 0.5 -11.2, 1.6 -12.3 Z M 3.4 -4.8
         C 4 -4.8, 16.9 -6.6, 17.5 -6.9 C 18.2 -7.2, 17.9 -9.9, 17.2 -10
         C 16.6 -10.1, 5.1 -8.8, 4.4 -8.5 C 3.7 -8.2, 2.7 -4.9, 3.4 -4.8 Z" />` },

    { name: 'rake',
      // p.4 — the fan of strokes standing off the margin
      d: `<path d="M -29 23.6 C -26.2 23.1, 24.2 18.7, 27.1 18.7
         C 30 18.7, 31.8 23.5, 29 23.9 C 26.3 24.4, -25.7 28.6, -28.6 28.6
         C -31.5 28.6, -31.7 24.1, -29 23.6 Z M -25.9 22
         C -25.7 19.5, -18.7 -25.5, -18.2 -27.9
         C -17.7 -30.4, -15.7 -29.5, -15.9 -27 C -16.1 -24.5, -22 19.9, -22.5 22.4
         C -23 24.8, -26.1 24.5, -25.9 22 Z M -15.8 22
         C -15.7 19.8, -10.6 -19.8, -10.3 -22 C -9.9 -24.1, -8.9 -23.6, -9 -21.4
         C -9.2 -19.2, -12.3 20.3, -12.6 22.5 C -13 24.7, -15.9 24.3, -15.8 22 Z
         M -6.6 21.7 C -6.6 19.2, -3.4 -24.6, -3.2 -27.1
         C -3 -29.5, -2.3 -28.9, -2.2 -26.4 C -2.2 -24, -2.4 20.3, -2.6 22.7
         C -2.8 25.1, -6.5 24.2, -6.6 21.7 Z M 2.1 21.3
         C 1.9 19.2, 2.2 -19.2, 2.4 -21.3 C 2.6 -23.5, 6.2 -23.7, 6.4 -21.5
         C 6.6 -19.4, 6.2 19.4, 6 21.6 C 5.7 23.7, 2.3 23.4, 2.1 21.3 Z M 11.4 22.6
         C 11.1 20.2, 9.6 -23.6, 9.7 -26.1 C 9.7 -28.6, 12.2 -29.4, 12.6 -27
         C 12.9 -24.6, 16.8 20, 16.7 22.5 C 16.7 25, 11.8 25.1, 11.4 22.6 Z
         M 21.3 22.4 C 20.9 20.3, 16.7 -18.3, 16.6 -20.4
         C 16.5 -22.6, 18.6 -22.6, 19 -20.5 C 19.5 -18.4, 25.5 19.9, 25.6 22
         C 25.7 24.2, 21.8 24.5, 21.3 22.4 Z" />` },

    { name: 'mask',
      // p.4 — the small masked face; two cut slits and no mouth
      d: `<path d="M -19.7 -19.3 C -18.9 -19.8, 5.2 -26.8, 6.6 -26.5
         C 8.1 -26.2, 23.4 -10.9, 23.7 -9.9 C 24 -8.9, 19.2 11.6, 18.4 12.8
         C 17.6 14, 0.1 26.3, -0.8 26.2 C -1.6 26.1, -15 10.4, -16 9
         C -17 7.7, -24.5 -5.1, -24.6 -6.1 C -24.7 -7, -20.5 -18.8, -19.7 -19.3 Z
         M -14.2 -12.9 C -14.4 -12.1, -11.3 0.7, -10.9 1.5
         C -10.6 2.2, -7.9 2.7, -7.8 1.9 C -7.6 1.1, -7.6 -13.2, -7.9 -13.9
         C -8.3 -14.6, -14.1 -13.6, -14.2 -12.9 Z M 4.9 -15.5
         C 4.7 -14.8, 6.1 -2.3, 6.4 -1.6 C 6.6 -0.9, 10.4 -0.4, 10.6 -1.1
         C 10.8 -1.9, 10.7 -15.7, 10.4 -16.4 C 10.1 -17.1, 5.1 -16.3, 4.9 -15.5 Z" />` },

    { name: 'pot',
      // p.30 — the small pot with its spout
      d: `<path d="M -11.8 -17.2 C -10 -18.6, 10 -20.4, 11.9 -19.1
         C 13.8 -17.7, 17.2 -1.2, 16.8 2.8 C 16.4 6.8, 9.9 20, 8.2 21.3
         C 6.4 22.7, -7.9 23.9, -9.6 22.7 C -11.2 21.5, -16 7.1, -16.2 3.1
         C -16.4 -0.9, -13.7 -15.7, -11.8 -17.2 Z M -8 -8
         C -8.1 -7.5, -5.3 1.3, -4.9 1.7 C -4.6 2.1, -1.2 0.9, -1.1 0.3
         C -0.9 -0.2, -1.9 -8.9, -2.3 -9.3 C -2.6 -9.8, -7.8 -8.6, -8 -8 Z
         M -14.8 -20.6 C -13.3 -20.9, 12.7 -21.8, 14.2 -21.6
         C 15.6 -21.4, 15.7 -16.9, 14.3 -16.6
         C 12.9 -16.3, -13.2 -15.1, -14.7 -15.3
         C -16.1 -15.5, -16.2 -20.3, -14.8 -20.6 Z M 14.3 -6
         C 15.1 -7.2, 28.4 -13.8, 29.3 -13.9 C 30.2 -14.1, 32.4 -9.4, 31.8 -8.5
         C 31.1 -7.6, 18 3.4, 16.5 3.6 C 15 3.8, 13.4 -4.9, 14.3 -6 Z" />` },

    { name: 'drop',
      // p.15 — the drop let go at the end of the band
      d: `<path d="M 1.5 -30.6 C 1.8 -29.4, 2 -7.4, 1.9 -6.2 C 1.8 -4.9, 0 -4.1, -0.3 -5.3
         C -0.6 -6.5, -3.9 -28.2, -3.8 -29.5 C -3.8 -30.8, 1.2 -31.7, 1.5 -30.6 Z
         M -0.2 -9.2 C 3.7 -9, 13.1 2.5, 13.8 6.9 C 14.6 11.2, 7.7 21.3, 5.4 23.2
         C 3 25, -4.5 24.9, -6.6 22.9 C -8.7 20.8, -13.5 9.8, -12.6 5.5
         C -11.8 1.2, -4.2 -9.4, -0.2 -9.2 Z" />` }
  ];

  // A project that has to keep a particular mark, whatever order the list
  // falls in. The grave was on Explainer before the emblems were reassigned
  // by position, so it is held there by name instead of by luck.
  const GLYPH_PINS = {
    'work-1787235011394': 'mound'   // Explainer — the grave, back where it was
  };

  // ------------------------------------------------------------------------
  // GLYPH IMAGES
  // Drop artwork into esset/glyphs/ and each project picks one — no code edit.
  // The folder is read from the server's directory listing, so adding a file
  // is the whole workflow. If the folder is empty we fall back to the drawn
  // SVG emblems below.
  // ------------------------------------------------------------------------
  const GLYPH_DIR = 'esset/glyphs/';
  let glyphImages = null; // null = not looked yet, [] = looked and found none

  async function loadGlyphImages() {
    if (glyphImages !== null) return glyphImages;
    glyphImages = [];
    // The folder listing only exists on the local server. Online (Netlify)
    // there is none, so asking would only log a 404 — use the drawn emblems.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return glyphImages;
    try {
      const res = await fetchWithTimeout(GLYPH_DIR, {}, 1500);
      if (!res.ok) return glyphImages;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      glyphImages = Array.from(doc.querySelectorAll('a[href]'))
        .map(a => a.getAttribute('href'))
        .filter(h => /\.(png|jpe?g|svg|webp|gif)$/i.test(h))
        .map(h => GLYPH_DIR + h.split('/').pop());
    } catch (e) {
      glyphImages = [];
    }
    return glyphImages;
  }


  function hashId(key) {
    let hash = 0;
    const s = String(key || '');
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return hash;
  }

  // Give every project a DIFFERENT image: walk the id-ordered project list and
  // deal images out in turn, so two projects only repeat once the folder runs
  // out. Falls back to a stable hash when the project isn't in the list yet.
  function pickGlyphImage(projectId, images) {
    if (!images.length) return null;
    const idx = projects.findIndex(p => p.id === projectId);
    const slot = idx === -1 ? hashId(projectId) : idx;
    return images[slot % images.length];
  }

  function glyphSlotFor(projectId) {
    const pinned = GLYPH_PINS[projectId];
    if (pinned) {
      const at = PROJECT_GLYPHS.findIndex(gl => gl.name === pinned);
      if (at !== -1) return at;
    }
    // Everything a pin has claimed is off the table; the rest of the projects
    // take what is left, in list order, so no two ever land on the same mark.
    const claimed = new Set();
    Object.keys(GLYPH_PINS).forEach(id => {
      const at = PROJECT_GLYPHS.findIndex(gl => gl.name === GLYPH_PINS[id]);
      if (at !== -1) claimed.add(at);
    });
    const free = [];
    PROJECT_GLYPHS.forEach((gl, i) => { if (!claimed.has(i)) free.push(i); });
    if (!free.length) return 0;

    let rank = 0, found = false;
    for (let i = 0; i < projects.length; i++) {
      const proj = projects[i];
      if (!proj || GLYPH_PINS[proj.id]) continue;
      if (proj.id === projectId) { found = true; break; }
      rank++;
    }
    if (!found) {
      // not in the list yet (a project being created): fall back to the id
      let hash = 0;
      const key = String(projectId || '');
      for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      }
      rank = hash;
    }
    return free[rank % free.length];
  }

  function buildProjectGlyph(projectId) {
    const marks = PROJECT_GLYPHS[glyphSlotFor(projectId)].d;
    return `<svg class="modal-caption-glyph" viewBox="-44 -44 88 88"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${marks}</svg>`;
  }

  // ------------------------------------------------------------------------
  // CAPTION / MEDIA BASELINE
  // `align-self: end` only lines the caption up with the bottom of the whole
  // media COLUMN — and that column also holds the drop-zone and the "add
  // existing projects" button, which sit well below the artwork. So the text
  // ended up floating far under the picture. Lift it by the height of that
  // trailing UI so the last line of type sits on the media's bottom edge.
  // ------------------------------------------------------------------------
  // Two columns only pay for themselves once each one holds a real paragraph.
  // A short description balanced across two columns becomes a line on the
  // left and a line on the right — two fragments, not a text. So measure the
  // body as it would set in two columns, and below four lines a column set it
  // as one narrow column at the same measure, centred under the heading; two
  // lines or fewer are a caption and are centred line by line too.
  const MIN_LINES_PER_COLUMN = 4;

  function fitCaptionColumns() {
    const lines = document.querySelector('#project-modal .modal-caption-lines');
    const body = document.getElementById('modal-desc-read');
    if (!lines || !body || !body.offsetParent) return;

    lines.classList.remove('is-single', 'is-caption');
    const lh = parseFloat(getComputedStyle(body).lineHeight) || 16;
    const total = Array.from(body.getClientRects())
      .reduce((s, r) => s + Math.round(r.height / lh), 0);
    if (total < MIN_LINES_PER_COLUMN * 2) lines.classList.add('is-single');
    if (lines.classList.contains('is-single')) {
      const single = Math.round(body.getBoundingClientRect().height / lh);
      if (single <= 2) lines.classList.add('is-caption');
    }
  }

  function alignCaptionToMedia() {
    const cap = document.getElementById('modal-caption-left');
    const wrapper = document.getElementById('modal-media-wrapper');
    const container = document.querySelector('.modal-split-container');
    if (!cap || !wrapper || !container) return;

    // While the sidebar is in edit mode it is far taller than the text it
    // stands in for, and re-aligning it then moves the artwork hundreds of
    // pixels in the middle of typing. Leave BOTH the offset and the media
    // exactly where they were until the text locks back — zeroing the margin
    // first would move it just as much, only upward.
    const editing = document.getElementById('modal-caption-edit');
    if (editing && !editing.hidden) return;

    fitCaptionColumns();
    fitPlate();

    cap.style.marginBottom = '0px';

    // Stacked single-column layout (narrow screens): nothing to align to.
    const columns = getComputedStyle(container).gridTemplateColumns.split(' ').filter(Boolean).length;
    if (columns < 2) return;

    const media = wrapper.querySelector('.modal-gallery-single, .modal-gallery-scroll');
    if (!media) return;

    const lift = cap.getBoundingClientRect().bottom - media.getBoundingClientRect().bottom;
    if (lift > 0) cap.style.marginBottom = lift + 'px';
  }

  // Multi-image plates: split the items into rows whose lengths differ by at
  // most one (7 → 4 over 3, 5 → 3 over 2), longer rows on top, every row
  // centred. All items share one height, so the rows read as one set; that
  // height is the largest that lets every row fit the column and the whole
  // stack fit the same vertical budget as a single work — nothing is ever
  // cropped or pushed sideways into a scroll.
  const GALLERY_GAP = 20;

  function galleryAspect(item) {
    const m = item.querySelector('img, video');
    if (!m) return 1;
    const w = m.naturalWidth || m.videoWidth, h = m.naturalHeight || m.videoHeight;
    return w && h ? w / h : 1;
  }

  function balancedRows(n, r) {
    const base = Math.floor(n / r), extra = n % r, sizes = [];
    for (let i = 0; i < r; i++) sizes.push(base + (i < extra ? 1 : 0));
    return sizes;
  }

  function layoutGalleryRows() {
    const plate = document.querySelector('#modal-media-wrapper .modal-gallery-scroll');
    if (!plate) return;
    const items = Array.from(plate.querySelectorAll('.gallery-card-item'))
      .sort((a, b) => a.dataset.index - b.dataset.index);
    const n = items.length;
    const width = Math.floor(plate.clientWidth * plateScaleFor());
    if (!n || !width) return;

    const budget = plateBudget || Math.min(window.innerHeight * 0.56, 600);
    const ratios = items.map(galleryAspect);

    let best = null;
    for (let r = 1; r <= n; r++) {
      const sizes = balancedRows(n, r);
      let h = (budget - GALLERY_GAP * (r - 1)) / r;
      let at = 0;
      for (const len of sizes) {
        const sum = ratios.slice(at, at + len).reduce((s, a) => s + a, 0);
        h = Math.min(h, (width - GALLERY_GAP * (len - 1)) / sum);
        at += len;
      }
      if (!best || h > best.h + 0.5) best = { h, sizes };
    }

    const h = Math.floor(best.h);
    const rows = [];
    let at = 0;
    best.sizes.forEach(len => {
      const row = document.createElement('div');
      row.className = 'gallery-row';
      items.slice(at, at + len).forEach((item, k) => {
        item.style.height = h + 'px';
        item.style.width = Math.floor(h * ratios[at + k]) + 'px';
        row.appendChild(item);
      });
      rows.push(row);
      at += len;
    });

    plate.replaceChildren(...rows);
    bindHoverZoom();
  }

  // ------------------------------------------------------------------------
  // HOVER TO ENLARGE
  // A work shown small (a gallery sets several to a row) grows in place while
  // the pointer is on it: up to twice its size, never past three quarters of
  // the screen's height, nudged back inside the page if growing from its own
  // centre would push it off an edge. The others dim so the one under the
  // pointer reads alone. Works already shown large are left as they are.
  // ------------------------------------------------------------------------
  const GALLERY_ZOOM_HEIGHT = 0.72;  // project view: grow to this share of the screen's height
  const GALLERY_ZOOM_MAX = 6;


  function zoomItem(item, on) {
    if (!on) {
      item.style.transform = '';
      item.classList.remove('is-zoomed');
      return;
    }
    const card = document.querySelector('#project-modal .modal-card');
    if (!card) return;
    item.style.transform = '';
    const r = item.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pad = 24;
    // Grow to a share of the screen, not by a fixed factor: in a dense gallery
    // (twenty works to a page) twice a thumbnail is still a thumbnail.
    // A work shown on its own is already large, so it may grow to the page's
    // full height (over its own caption, while the pointer is on it).
    const single = item.classList.contains('modal-gallery-single');
    if (single) {
      // Only posters and upright works: a film is already as wide as the page,
      // and the pointer goes to it to mute it, not to have it jump.
      const m = item.querySelector('img, video');
      const ar = m ? mediaAspect(m) : 0;
      const poster = currentModalProject && formatOf(currentModalProject) === 'POSTER';
      if (!poster && !(ar > 0 && ar < 0.8)) return;
    }
    const share = single ? (c.height - 2 * pad) / c.height : GALLERY_ZOOM_HEIGHT;
    const s = Math.min(GALLERY_ZOOM_MAX, (c.height * share) / r.height, (c.width - 2 * pad) / r.width);
    if (s < (single ? 1.06 : 1.15)) return;     // no real gain: leave it
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hw = r.width * s / 2, hh = r.height * s / 2;
    let dx = 0, dy = 0;
    if (cx - hw < c.left + pad) dx = c.left + pad - (cx - hw);
    else if (cx + hw > c.right - pad) dx = (c.right - pad) - (cx + hw);
    if (cy - hh < c.top + pad) dy = c.top + pad - (cy - hh);
    else if (cy + hh > c.bottom - pad) dy = (c.bottom - pad) - (cy + hh);
    item.style.transform = 'translate(' + Math.round(dx) + 'px, ' + Math.round(dy) + 'px) scale(' + s.toFixed(3) + ')';
    item.style.setProperty('--zoom', s.toFixed(3));
    item.classList.add('is-zoomed');
  }

  function bindHoverZoom() {
    document.querySelectorAll('#modal-media-wrapper .modal-gallery-scroll .gallery-card-item, #modal-media-wrapper .modal-gallery-single').forEach(item => {
      item.classList.remove('is-zoomed');
      item.style.transform = '';
      if (item.dataset.hoverZoom) return;
      item.dataset.hoverZoom = '1';
      item.addEventListener('mouseenter', () => zoomItem(item, true));
      item.addEventListener('mouseleave', () => zoomItem(item, false));
      item.addEventListener('dragstart', () => zoomItem(item, false));
    });
  }

  // ------------------------------------------------------------------------
  // THE PLATE: one composition, centred in the screen
  // The work and everything written under it are one block, set in the middle
  // of the screen with the same margin above the work, between the work and
  // its text, and below the text. The text is only as tall as it is, so the
  // work gets every pixel that is left: a small poster grows to fill the
  // height, and a wide film stops at the column's width instead (then the
  // block is shorter than the screen and centring splits the rest evenly).
  // ------------------------------------------------------------------------
  // playbackRate: a project may run faster (or slower) than its file, e.g.
  // 1.75 for a long page-flip. load() resets the rate, so it is set as the
  // default rate too and re-applied once the clip reports its metadata.
  function applyClipSpeed(v, proj) {
    const rate = Number(proj && proj.playbackRate) || 1;
    if (!v || rate === 1) return;
    const set = () => { v.defaultPlaybackRate = rate; v.playbackRate = rate; };
    set();
    v.addEventListener('loadedmetadata', set);
    v.addEventListener('play', set);
  }

  let plateBudget = 0;
  // The work takes this share of the room the text leaves it, not all of it,
  // so it sits in the page with air around it rather than pressing on the edges.
  const PLATE_SCALE = 0.86;
  // A project can ask for more (or less) of that room with "plateScale".
  // Posters get all of it by default: they are upright, so height is what
  // limits them, and at 86% they read smaller than the films beside them.
  function plateScaleFor() {
    // On a phone the work takes the full width — the margin that lets it
    // breathe on a laptop screen just makes it small there.
    if (window.innerWidth <= 768) return 1;
    const v = Number(currentModalProject && currentModalProject.plateScale);
    if (v > 0) return Math.min(v, 1);
    if (currentModalProject && formatOf(currentModalProject) === 'POSTER') return 1;
    return PLATE_SCALE;
  }

  function plateMargin(cardH) {
    return Math.max(28, Math.round(cardH * 0.045));
  }

  function mediaAspect(m) {
    const w = m.naturalWidth || m.videoWidth, h = m.naturalHeight || m.videoHeight;
    return w && h ? w / h : 0;
  }

  function fitPlate() {
    const card = document.querySelector('#project-modal .modal-card');
    const split = document.querySelector('#project-modal .modal-split-container');
    const cap = document.getElementById('modal-caption-left');
    const wrapper = document.getElementById('modal-media-wrapper');
    if (!card || !split || !cap || !wrapper || !card.clientHeight) return;

    const cs = getComputedStyle(card);
    const cardH = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    // An upright work (a story-format poster) is limited by height alone, so
    // every pixel of margin comes straight off it: it gets tighter margins and
    // the full share of the room, whatever its format says.
    const lead = wrapper.querySelector('.modal-gallery-single img, .modal-gallery-single video');
    const leadAr = lead ? mediaAspect(lead) : 0;
    const upright = leadAr > 0 && leadAr < 0.8;
    const m = upright ? Math.max(18, Math.round(cardH * 0.025)) : plateMargin(cardH);
    card.style.setProperty('--plate-margin', m + 'px');
    // The card's height comes from max-height, which a percentage min-height
    // cannot resolve against — so the block is given the screen in pixels.
    split.style.minHeight = Math.floor(cardH) + 'px';

    // Everything but the work: the margin above, the gap, the text, the margin below.
    plateBudget = Math.round((upright ? 1 : plateScaleFor()) *
      Math.max(Math.round(cardH * 0.38), Math.floor(cardH - 3 * m - cap.offsetHeight)));

    const single = wrapper.querySelector('.modal-gallery-single');
    const media = single && single.querySelector('img, video');
    if (media) {
      const ar = mediaAspect(media);
      if (ar) {
        // The column's width, not the frame's: the frame shrinks to the work.
        const w = Math.min(plateScaleFor() * (wrapper.clientWidth || split.clientWidth), plateBudget * ar);
        media.style.width = Math.floor(w) + 'px';
        media.style.height = Math.floor(w / ar) + 'px';
      }
      // mediaZoom: enlarge the work inside its own frame, for clips shot
      // with black around the subject. The frame keeps its size (so the
      // layout still fits) and clips only the black margin.
      const zoom = Number(currentModalProject && currentModalProject.mediaZoom) || 1;
      media.style.transform = zoom !== 1 ? 'scale(' + zoom + ')' : '';
      media.style.transformOrigin = '50% 50%';
    }
    layoutGalleryRows();
    bindHoverZoom();
  }

  function schedulePlateFit() {
    fitPlate();
    const wrapper = document.getElementById('modal-media-wrapper');
    if (!wrapper) return;
    wrapper.querySelectorAll('img').forEach(im => {
      if (!im.complete) im.addEventListener('load', fitPlate, { once: true });
    });
    wrapper.querySelectorAll('video').forEach(v => {
      if (!v.videoWidth) v.addEventListener('loadedmetadata', fitPlate, { once: true });
    });
  }

  let galleryResizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(galleryResizeFrame);
    galleryResizeFrame = requestAnimationFrame(fitPlate);
  });

  // Media height settles after the video/image reports its dimensions.
  function scheduleCaptionAlign() {
    alignCaptionToMedia();
    const wrapper = document.getElementById('modal-media-wrapper');
    if (wrapper) {
      wrapper.querySelectorAll('video').forEach(v => {
        v.addEventListener('loadedmetadata', alignCaptionToMedia, { once: true });
      });
      wrapper.querySelectorAll('img').forEach(im => {
        if (!im.complete) im.addEventListener('load', alignCaptionToMedia, { once: true });
      });
    }
    setTimeout(alignCaptionToMedia, 120);
    setTimeout(alignCaptionToMedia, 450);
  }

  window.addEventListener('resize', alignCaptionToMedia);

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------------------------
  // IN-MODAL DESCRIPTION EDITOR
  // Edit the description straight inside the open project and persist it to
  // projects.json on disk (via saveProjectsData) so it survives a reload.
  // ------------------------------------------------------------------------
  // ------------------------------------------------------------------------
  // WHAT A PROJECT IS, IN TWO WORDS
  // The medium line used to read "AFTER EFFECTS, BLENDER" — the toolkit, not
  // the thing. A work is one of a short list of formats, and that is what is
  // worth knowing beside the year.
  // ------------------------------------------------------------------------
  const FORMAT_OPTIONS = [
    'MOVIE', 'ANIMATION', 'POSTER', 'PRINTED CATALOGUE', 'TITLE SEQUENCE',
    'IDENTITY', 'INSTALLATION', 'BOOK', 'ILLUSTRATION', 'EXHIBITION'
  ];

  function formatOf(proj) {
    if (!proj) return '';
    const explicit = String(proj.format || '').trim();
    if (explicit) return explicit.toUpperCase();
    // Nothing chosen yet: take the honest guess from what the project holds.
    const moving = proj.isVideo || isVideoUrl(proj.videoAsset || proj.asset || '');
    return moving ? 'ANIMATION' : 'POSTER';
  }

  // The same number the card carries in the grid. renderPortfolio counts down
  // from the newest, so it is derived from position — which is why it is
  // shown here but not offered as a field: typing a different one would be
  // overwritten by the next render.
  function workNumberOf(projectId) {
    const idx = projects.findIndex(p => p.id === projectId);
    return idx === -1 ? null : idx + 1;
  }

  function padWorkNo(n) {
    return n == null ? '' : (n < 10 ? '0' + n : String(n));
  }

  function bindDescriptionEditor(data) {
    const view = document.getElementById('modal-caption-view');
    if (!EDIT_MODE) {
      // Client-ready: the caption is just text. No tooltip, no editor.
      if (view) view.removeAttribute('title');
      return;
    }
    const editBox = document.getElementById('modal-caption-edit');
    const titleRead = document.getElementById('modal-title-read');
    const stampRead = document.getElementById('modal-stamp-read');
    const descRead = document.getElementById('modal-desc-read');
    const metaRead = document.getElementById('modal-meta-read');
    const titleInput = document.getElementById('modal-title-input');
    const yearInput = document.getElementById('modal-year-input');
    const formatInput = document.getElementById('modal-format-input');
    const descInput = document.getElementById('modal-desc-input');
    const metaInput = document.getElementById('modal-meta-input');
    const editBtn = document.getElementById('modal-desc-edit-btn');
    const saveBtn = document.getElementById('modal-desc-save-btn');
    const cancelBtn = document.getElementById('modal-desc-cancel-btn');
    const clearBtn = document.getElementById('modal-desc-clear-btn');
    const deleteBtn = document.getElementById('modal-desc-delete-btn');
    const confirmBox = document.getElementById('modal-desc-confirm');
    const deleteYes = document.getElementById('modal-desc-delete-yes');
    const deleteNo = document.getElementById('modal-desc-delete-no');
    const undoBtn = document.getElementById('modal-desc-undo-btn');
    const pasteBtn = document.getElementById('modal-desc-paste-btn');
    const copyBtn = document.getElementById('modal-export-copy-btn');
    const fileBtn = document.getElementById('modal-export-file-btn');
    if (!editBtn || !saveBtn) return;

    const fields = [titleInput, yearInput, formatInput, descInput, metaInput];
    const valueOf = (el) => (el ? el.value.replace(/ /g, ' ').trim() : '');
    const snapshot = () => fields.map(el => (el ? el.value : '')).join('\u0000');
    let committed = snapshot();

    // A textarea that does not grow hides the end of a long description
    // behind a scrollbar in a sidebar this narrow.
    function grow(el) {
      if (!el || el.tagName !== 'TEXTAREA') return;
      el.style.height = 'auto';
      el.style.height = Math.max(el.scrollHeight, 18) + 'px';
    }

    function refreshDirty() {
      saveBtn.classList.toggle('is-dirty', snapshot() !== committed);
    }

    function setMode(editing) {
      if (view) view.hidden = editing;
      if (editBox) editBox.hidden = !editing;
      editBtn.hidden = editing;
      if (deleteBtn) deleteBtn.hidden = editing;
      if (pasteBtn) pasteBtn.hidden = !editing;
      if (confirmBox) confirmBox.hidden = true;
      saveBtn.hidden = !editing;
      if (cancelBtn) cancelBtn.hidden = !editing;
      if (clearBtn) clearBtn.hidden = !editing;
      // The caption's height just changed, so its baseline has to be redone.
      scheduleCaptionAlign();
      if (editing) {
        fields.forEach(grow);
        if (descInput) {
          descInput.focus();
          const end = descInput.value.length;
          try { descInput.setSelectionRange(end, end); } catch (e) {}
        }
        refreshDirty();
      }
    }

    function paintReadLines() {
      if (titleRead) titleRead.textContent = valueOf(titleInput);
      if (descRead) descRead.textContent = valueOf(descInput);
      fitCaptionColumns();
      if (metaRead) metaRead.textContent = valueOf(metaInput);
      if (stampRead) {
        stampRead.textContent = [valueOf(yearInput), valueOf(formatInput).toUpperCase()]
          .filter(Boolean).join(' · ');
      }
    }

    function enterEdit() { setMode(true); }

    editBtn.addEventListener('click', enterEdit);
    // The read-only block is also the way in, so the text itself is the
    // target rather than a button the eye has to find first.
    if (view) view.addEventListener('click', enterEdit);

    let autoSaveTimer = null;
    fields.forEach(el => {
      if (!el) return;
      el.addEventListener('input', () => {
        grow(el);
        refreshDirty();
        // ZERO DATA LOSS SAFEGUARD: Continuous Auto-Save
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(async () => {
          if (saveBtn && !saveBtn.disabled) {
            // Silently persist without disrupting UI
            const patch = {
              title: valueOf(titleInput),
              description: valueOf(descInput),
              subtitle: valueOf(descInput),
              year: valueOf(yearInput),
              format: valueOf(formatInput).toUpperCase()
            };
            const idx = projects.findIndex(p => p.id === data.id);
            if (idx !== -1) {
              Object.assign(projects[idx], patch);
              Object.assign(data, projects[idx]);
              if (currentModalProject && currentModalProject.id === data.id) {
                Object.assign(currentModalProject, projects[idx]);
              }
              recordEdit(data.id, patch);
              try {
                localStorage.setItem('mihal_projects_cms_v5', JSON.stringify(projects));
                if (EDIT_MODE) fetch('./save-projects', {
                  method: 'POST',
                  body: JSON.stringify(projects),
                  headers: {'Content-Type': 'application/json'}
                }).catch(()=>{});
              } catch (e) {}
              committed = snapshot();
              refreshDirty();
            }
          }
        }, 1500); // 1.5s debounce
      });
      el.addEventListener('keydown', (e) => {
        // Enter belongs to the textarea — a description runs to more than one
        // line. Saving is deliberate: the button, or ctrl/cmd + Enter.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || el.tagName === 'INPUT')) {
          e.preventDefault();
          saveBtn.click();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          if (cancelBtn) cancelBtn.click();
        }
      });
    });

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const parts = committed.split('\u0000');
        fields.forEach((el, i) => { if (el) el.value = parts[i] || ''; });
        setMode(false);
        refreshDirty();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        fields.forEach(el => { if (el) { el.value = ''; grow(el); } });
        refreshDirty();
        if (descInput) descInput.focus();
      });
    }

    // Ctrl/Cmd+V works in the fields on its own — nothing here ever blocked
    // it — but the button is there for when the keyboard is not, and it drops
    // the text in at the cursor rather than replacing what is already written.
    if (pasteBtn) {
      pasteBtn.addEventListener('click', async () => {
        const el = document.activeElement && document.activeElement.value !== undefined
          ? document.activeElement : descInput;
        if (!el) return;
        let text = '';
        try {
          text = await navigator.clipboard.readText();
        } catch (err) {
          showToast('⚠️ הדפדפן לא נתן גישה ללוח — השתמשי ב‑' +
                    (navigator.platform.indexOf('Mac') === 0 ? 'Cmd+V' : 'Ctrl+V'));
          el.focus();
          return;
        }
        if (!text) { showToast('הלוח ריק'); el.focus(); return; }
        const a = el.selectionStart == null ? el.value.length : el.selectionStart;
        const b = el.selectionEnd == null ? el.value.length : el.selectionEnd;
        el.value = el.value.slice(0, a) + text + el.value.slice(b);
        const at = a + text.length;
        el.focus();
        try { el.setSelectionRange(at, at); } catch (e2) {}
        el.dispatchEvent(new Event('input', { bubbles: true }));
        showToast('📋 הודבק — לחצי שמור כדי לקבע');
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        if (await copyProjectsJson()) {
          showToast('⧉ כל ' + projects.length + ' הפרויקטים הועתקו כ-JSON');
          return;
        }
        // The clipboard is refused when the window is not focused. Rather
        // than leave with nothing, fall through to the file.
        showToast(downloadProjectsJson()
          ? '⧉ ההעתקה נחסמה — projects.json ירד במקום'
          : '⚠️ לא ניתן היה לייצא — פתחי את הקונסול והריצי exportProjects.json()');
      });
    }

    if (fileBtn) {
      fileBtn.addEventListener('click', () => {
        showToast(downloadProjectsJson()
          ? '⬇ projects.json ירד לתיקיית ההורדות'
          : '⚠️ ההורדה נכשלה');
      });
    }

    // ------------------------------------------------------------------
    // ONE WAY IN AND OUT
    // Saving and deleting are the same operation with different text, so
    // they go through one function: write the overlay FIRST (it cannot fail
    // or time out), then the array on screen, then the disk. A delete that
    // only reached the disk would come back on the next load, because the
    // overlay is re-applied on top of whatever the loader returns.
    // ------------------------------------------------------------------
    async function persist(patch, msgOk) {
      const idx = projects.findIndex(p => p.id === data.id);
      if (idx === -1) { showToast('⚠️ הפרויקט לא נמצא — לא נשמר'); return false; }

      Object.assign(projects[idx], patch);
      Object.assign(data, projects[idx]);
      if (currentModalProject && currentModalProject.id === data.id) {
        Object.assign(currentModalProject, projects[idx]);
      }
      const kept = recordEdit(data.id, patch);

      try {
        const onDisk = await saveProjectsData();
        renderPortfolio();
        if (onDisk) showToast(msgOk + ' (projects.json)');
        else if (kept) showToast(msgOk + ' — בדפדפן. ייצאי JSON כדי לקבע בקוד');
        else showToast('⚠️ לא ניתן היה לשמור — העתיקי את הטקסט לפני רענון');
        return true;
      } catch (err) {
        console.error('Project save failed:', err);
        showToast(kept ? '⚠️ הדיסק לא הגיב — נשמר בדפדפן'
                       : '⚠️ השמירה נכשלה — נסי שוב');
        return kept;
      }
    }

    // ---- delete, with a step in between and a way back ----------------
    let undoTimer = null;
    let deleted = null;           // what the last delete took away

    function showConfirm(on) {
      if (confirmBox) confirmBox.hidden = !on;
      if (deleteBtn) deleteBtn.hidden = on;
      editBtn.hidden = on || !editBox.hidden;
    }

    function offerUndo(previous) {
      deleted = previous;
      if (!undoBtn) return;
      undoBtn.hidden = false;
      clearTimeout(undoTimer);
      // Long enough to change your mind, short enough that the button is not
      // left sitting there as part of the furniture.
      undoTimer = setTimeout(() => { undoBtn.hidden = true; deleted = null; }, 30000);
    }

    if (deleteBtn) deleteBtn.addEventListener('click', () => showConfirm(true));
    if (deleteNo) deleteNo.addEventListener('click', () => showConfirm(false));

    if (deleteYes) {
      deleteYes.addEventListener('click', async () => {
        const previous = { description: data.description || '',
                           subtitle: data.subtitle || '' };
        showConfirm(false);
        if (descInput) descInput.value = '';
        await persist({ description: '', subtitle: '' }, '🗑️ התיאור נמחק');
        committed = snapshot();
        paintReadLines();
        offerUndo(previous);
      });
    }

    if (undoBtn) {
      undoBtn.addEventListener('click', async () => {
        if (!deleted) return;
        const back = deleted;
        deleted = null;
        undoBtn.hidden = true;
        clearTimeout(undoTimer);
        if (descInput) descInput.value = back.description;
        await persist(back, '↩ התיאור הוחזר');
        committed = snapshot();
        paintReadLines();
      });
    }

    saveBtn.addEventListener('click', async () => {
      const idx = projects.findIndex(p => p.id === data.id);
      if (idx === -1) { showToast('⚠️ הפרויקט לא נמצא — לא נשמר'); return; }

      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ שומר...';

      const newTitle = valueOf(titleInput);
      const newDesc = valueOf(descInput);
      const newMeta = valueOf(metaInput);
      const newYear = valueOf(yearInput);
      const newFormat = valueOf(formatInput).toUpperCase();

      // An emptied line is genuinely cleared, not quietly left as it was.
      const patch = {
        title: newTitle,
        description: newDesc,
        subtitle: newDesc,
        year: newYear,
        format: newFormat
      };
      if (newMeta.includes('—')) {
        const bits = newMeta.split('—');
        patch.category = bits[0].trim();
        patch.client = bits.slice(1).join('—').trim();
      } else {
        patch.category = newMeta;
        patch.client = '';
      }

      committed = snapshot();
      paintReadLines();
      setMode(false);

      const meta = document.getElementById('modal-top-right-meta');
      if (meta) {
        let html = '';
        if (newYear) html += '<div>YEAR: ' + escapeHtml(newYear) + '</div>';
        const shown = newFormat || formatOf(projects[idx]);
        if (shown) {
          html += '<div style="opacity: 0.85; margin-top: 0.2rem;">' +
                  escapeHtml(shown) + '</div>';
        }
        meta.innerHTML = html;
      }

      try {
        await persist(patch, '✓ נשמר');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 שמור';
        refreshDirty();
      }
    });

    setMode(false);
  }

  // ------------------------------------------------------------------------
  // THE EDITING TOOLS GO LAST
  // The dropzone and the "add existing projects" button are built inside the
  // media wrapper, which put roughly 450px of dashed box between the work and
  // the first line written about it — the text was pushed clean off the
  // screen. They are tools, not part of the page, so they are moved to the
  // end of the card after the media is laid out. Moving the nodes rather than
  // rebuilding them keeps every listener already bound to them.
  // ------------------------------------------------------------------------
  function relocateModalTools() {
    const container = document.querySelector('#project-modal .modal-split-container');
    const wrapper = document.getElementById('modal-media-wrapper');
    if (!container || !wrapper) return;
    // The tools live after the composition, not inside it: the work and its
    // text are centred as one block in the first screen, and the upload
    // tools wait below the fold for whoever scrolls to them.
    const card = container.parentElement;
    let tools = card.querySelector('.modal-tools');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'modal-tools';
    }
    tools.innerHTML = '';
    const dropzone = wrapper.querySelector('#modal-gallery-dropzone');
    if (dropzone) tools.appendChild(dropzone);
    // the attach button sits in a wrapper div of its own beside the dropzone
    Array.prototype.slice.call(wrapper.children).forEach(el => {
      if (el.querySelector && el.querySelector('#modal-attach-existing-btn')) {
        tools.appendChild(el);
      }
    });
    card.appendChild(tools);
  }


  function bindGalleryDeleteButtons(data, items) {
    const modalMediaWrapper = document.getElementById('modal-media-wrapper');
    if (!modalMediaWrapper) return;
    const deleteBtns = modalMediaWrapper.querySelectorAll('.delete-gallery-item-btn');
    deleteBtns.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const gItem = btn.closest('.gallery-card-item');
        if (!gItem) return;
        const idxToRemove = parseInt(gItem.getAttribute('data-index'), 10);
        
        if (confirm('למחוק את הדימוי הזה מהפרויקט?')) {
          // Remove from the computed items array using the exact DOM index
          items.splice(idxToRemove, 1);
          
          data.gallery = [...items];
          data.asset = '';
          data.videoAsset = '';
          data.isVideo = false;
          
          if (items.length > 0) {
            const firstItem = items[0];
            if (isVideoUrl(firstItem)) {
              data.videoAsset = firstItem;
              data.isVideo = true;
            } else {
              data.asset = firstItem;
            }
          }
          
          const existingIdx = projects.findIndex(p => p.id === data.id);
          if (existingIdx !== -1) {
            projects[existingIdx] = data;
          }
          
          try {
            await saveProjectsData();
            renderPortfolio();
            openProjectModal(data);
          } catch(err) {}
        }
      });
    });
  }

  function openProjectModal(data) {
    currentModalProject = data;
    modalSoundOn = true; // every project opens with its sound

    // STOP SHOWREEL MUSIC IMMEDIATELY WHEN ENTERING ANY PROJECT
    const mainReel = document.getElementById('main-showreel');
    const mainMuteBtn = document.getElementById('mute-btn');
    if (mainReel) {
      mainReel.muted = true;
      mainReel.pause();
      paintReelSound(mainMuteBtn, true);
    }

    const modalCaptionLeft = document.getElementById('modal-caption-left');
    const modalTopRightMeta = document.getElementById('modal-top-right-meta');

    const titleUpper = (data.title || 'PORTFOLIO WORK').toUpperCase();
    const descUpper = (data.description || data.subtitle || '').toUpperCase();
    const clientUpper = (data.client || '').trim().toUpperCase();
    const catUpper = (data.category || '').toUpperCase();
    const yearVal = (data.year || '').trim();
    const toolkitUpper = (data.toolkit || '').trim().toUpperCase();

    // DYNAMIC SPATIAL TINY ARROWS INDICATORS FOR PREV & NEXT REMAINING PROJECTS
    const currentIdx = projects.findIndex(p => p.id === data.id);
    if (currentIdx !== -1) {
      updateTinyArrowsIndicators(currentIdx, projects.length);
    }

    if (modalTopRightMeta) {
      let metaHtml = '';
      if (yearVal) {
        metaHtml += `<div>YEAR: ${escapeHtml(yearVal)}</div>`;
      }
      const fmt = formatOf(data);
      if (fmt) {
        metaHtml += `<div style="opacity: 0.85; margin-top: 0.2rem;">${escapeHtml(fmt)}</div>`;
      }
      modalTopRightMeta.innerHTML = metaHtml;
    }

    if (modalCaptionLeft) {
      let subMeta = '';
      if (catUpper && clientUpper) {
        subMeta = `${catUpper} — ${clientUpper}`;
      } else if (catUpper) {
        subMeta = catUpper;
      } else if (clientUpper) {
        subMeta = clientUpper;
      }
      // raw form for editing, so saving does not lock the text into capitals
      const cat = (data.category || '').trim();
      const client = (data.client || '').trim();
      const subMetaRaw = cat && client ? `${cat} — ${client}` : (cat || client);

      // The description is editable in place. Store the RAW text (uppercasing is
      // done with CSS) so saving never destroys the original casing.
      const descRaw = (data.description || data.subtitle || '').trim();

      // Every line in the sidebar is editable and can be emptied. A line left
      // blank is dropped from the project rather than kept as an empty row,
      // so unwanted text can simply be deleted and saved away.
      // Two modes. The sidebar reads as plain text until ערוך is pressed;
      // editing then happens in real fields, and שמור locks it back. The
      // previous version left the lines permanently contenteditable, which
      // meant a stray click in the sidebar was already an edit.
      //
      // The block is a hierarchy, not three lines of one size: the number and
      // the stamp are small marginal type, the title is the heading, and the
      // description is running text at reading size in its own casing.
      const workNo = padWorkNo(workNumberOf(data.id));
      const fmtVal = formatOf(data);
      const stampRaw = [yearVal, fmtVal].filter(Boolean).join(' · ');
      const datalist = FORMAT_OPTIONS
        .map(o => `<option value="${escapeHtml(o)}"></option>`).join('');

      let linesHtml = `
        <div class="modal-caption-view" id="modal-caption-view" title="לחצי כדי לערוך">
          <!-- Under the mark, the catalogue line first: the number and what
               the thing is, small and tracked, then its name. -->
          <div class="modal-work-no" id="modal-no-read">${workNo ? 'NO. ' + workNo : ''}</div>
          <div class="modal-work-stamp" id="modal-stamp-read">${escapeHtml(stampRaw)}</div>
          <h3 class="modal-work-title" id="modal-title-read" data-placeholder="שם הפרויקט...">${escapeHtml(data.title || '')}</h3>
          <div class="modal-work-body" id="modal-desc-read" data-placeholder="תיאור...">${escapeHtml(descRaw)}</div>
          <div class="modal-work-credit" id="modal-meta-read" data-placeholder="קטגוריה / סטודיו...">${escapeHtml(subMetaRaw)}</div>
        </div>
        <div class="modal-caption-edit" id="modal-caption-edit" hidden>
          <div class="modal-work-no modal-field-static">${workNo ? 'NO. ' + workNo : ''}<span class="modal-field-note">מספר לפי הסדר בגריד</span></div>
          <label class="modal-field-label" for="modal-title-input">כותרת</label>
          <textarea class="modal-field modal-field-title" id="modal-title-input" rows="1" spellcheck="false"
                    aria-label="Project title" placeholder="שם הפרויקט...">${escapeHtml(data.title || '')}</textarea>
          <div class="modal-field-pair">
            <div>
              <label class="modal-field-label" for="modal-year-input">שנה</label>
              <input class="modal-field" id="modal-year-input" type="text" inputmode="numeric"
                     spellcheck="false" aria-label="Year" placeholder="2026"
                     value="${escapeHtml(yearVal)}">
            </div>
            <div>
              <label class="modal-field-label" for="modal-format-input">פורמט</label>
              <input class="modal-field" id="modal-format-input" type="text" list="modal-format-options"
                     spellcheck="false" aria-label="Format" placeholder="ANIMATION"
                     value="${escapeHtml(fmtVal)}">
              <datalist id="modal-format-options">${datalist}</datalist>
            </div>
          </div>
          <label class="modal-field-label" for="modal-desc-input">טקסט רץ</label>
          <textarea class="modal-field modal-field-desc" id="modal-desc-input" rows="5" spellcheck="false"
                    aria-label="Project description" placeholder="תיאור...">${escapeHtml(descRaw)}</textarea>
          <label class="modal-field-label" for="modal-meta-input">קרדיט</label>
          <textarea class="modal-field modal-field-muted" id="modal-meta-input" rows="1" spellcheck="false"
                    aria-label="Category and client" placeholder="קטגוריה / סטודיו...">${escapeHtml(subMetaRaw)}</textarea>
        </div>
        <div class="modal-edit-actions">
          <button type="button" class="modal-export-btn" id="modal-export-copy-btn"
                  title="העתק את כל הפרויקטים כ-JSON להדבקה בקוד">⧉ JSON</button>
          <button type="button" class="modal-export-btn" id="modal-export-file-btn"
                  title="הורד projects.json">⬇</button>
          <button type="button" class="modal-desc-save-btn" id="modal-desc-edit-btn">✏️ ערוך</button>
          <button type="button" class="modal-desc-clear-btn modal-desc-danger"
                  id="modal-desc-delete-btn" title="מחק את התיאור">🗑️ מחק</button>
          <span class="modal-desc-confirm" id="modal-desc-confirm" hidden>
            <span class="modal-desc-ask">למחוק את התיאור?</span>
            <button type="button" class="modal-desc-clear-btn modal-desc-danger"
                    id="modal-desc-delete-yes">כן, מחק</button>
            <button type="button" class="modal-desc-clear-btn"
                    id="modal-desc-delete-no">בטל</button>
          </span>
          <button type="button" class="modal-desc-save-btn modal-desc-undo"
                  id="modal-desc-undo-btn" hidden>↩ החזר</button>
          <button type="button" class="modal-desc-save-btn" id="modal-desc-save-btn" hidden>💾 שמור</button>
          <button type="button" class="modal-desc-clear-btn" id="modal-desc-paste-btn"
                  title="הדבק מהלוח לתוך התיאור" hidden>📋 הדבק</button>
          <button type="button" class="modal-desc-clear-btn" id="modal-desc-cancel-btn" hidden>בטל</button>
          <button type="button" class="modal-desc-clear-btn" id="modal-desc-clear-btn"
                  title="נקה את כל השורות" hidden>נקה</button>
        </div>`;

      modalCaptionLeft.innerHTML = `
        <div class="modal-caption-emblem">
          ${buildProjectGlyph(data.id)}
        </div>
        <div class="modal-caption-lines">
          ${linesHtml}
        </div>
      `;

      bindDescriptionEditor(data);
    }

    let items = [];
    if (data.gallery && Array.isArray(data.gallery) && data.gallery.length > 0) {
      items = data.gallery.filter(url => url && (!url.startsWith('blob:') || window.location.protocol === 'file:'));
    }
    if (data.videoAsset && !items.includes(data.videoAsset) && !data.videoAsset.startsWith('blob:')) {
      items.unshift(data.videoAsset);
    }
    if (data.asset && !items.includes(data.asset) && !data.asset.startsWith('blob:')) {
      items.push(data.asset);
    }
    items = Array.from(new Set(items));

    const dropzoneHtml = `
      <div class="modal-gallery-dropzone" id="modal-gallery-dropzone" title="גרור קבצים או לחץ להעלאה">
        <div class="modal-dropzone-inner">
          <span class="modal-dropzone-icon">📁 ⬇️</span>
          <div class="modal-dropzone-text">גרור לכאן קבצים נוספים להוספה לגלריה של הפרויקט</div>
          <div class="modal-dropzone-sub">ניתן לגרור מספר קבצים בבת אחת (וידאו / תמונות) • לחץ לבחירה מהמחשב</div>
        </div>
        <input type="file" id="modal-dropzone-file-input" multiple accept="video/*,image/*" style="display: none;">
      </div>
      <div style="text-align: center; margin: 0.8rem 0 2rem 0;">
        <button type="button" class="modal-attach-existing-btn" id="modal-attach-existing-btn">📁 ➕ הוסף פרויקטים קיימים מהפורטפוליו לתוך הפרויקט הזה</button>
      </div>
    `;

    if (modalMediaWrapper) {
      if (items.length <= 1) {
        // SINGLE MEDIA ITEM — CENTERED IN THE MIDDLE
        const src = items[0] || data.videoAsset || data.asset;
        const isVid = isVideoUrl(src);
        
        let singleHtml = '';
        if (isVid) {
          singleHtml = `
            <div class="modal-gallery-single gallery-card-item" data-index="0" style="background-color: #000000; min-height: 280px; position: relative;">
              <button type="button" class="delete-gallery-item-btn" title="מחק דימוי זה">×</button>
              <video src="${src}" autoplay loop muted playsinline preload="auto" class="modal-video" style="background-color: #000000;">
                Your browser does not support video play.
              </video>
            </div>
          `;
        } else {
          singleHtml = `
            <div class="modal-gallery-single gallery-card-item" data-index="0" style="position: relative;">
              <button type="button" class="delete-gallery-item-btn" title="מחק דימוי זה">×</button>
              <img src="${src || 'esset/placeholder_thumb.jpg'}" alt="${data.title}">
            </div>
          `;
        }
        modalMediaWrapper.innerHTML = singleHtml + dropzoneHtml;
        relocateModalTools();
        schedulePlateFit();
        scheduleCaptionAlign();
        bindGalleryDeleteButtons(data, items);

        const modalVid = modalMediaWrapper.querySelector('video');
        if (modalVid) {
          modalVid.loop = true;
          modalVid.load();
          // Honour the project's chosen opening moment (see startTime).
          const modalStartAt = Number(data.startTime) || 0;
          if (modalStartAt) {
            modalVid.addEventListener('loadedmetadata', () => {
              try { modalVid.currentTime = modalStartAt; } catch (e) {}
            }, { once: true });
          }
          // Opens with its sound; a click anywhere on the project mutes it.
          applyClipSpeed(modalVid, data);
          playWithSound(modalVid);
        }
      } else {
        // MULTIPLE MEDIA ITEMS — SLEEK VERTICAL SCROLL GALLERY (UP AND DOWN)
        let galleryHtml = `<div class="modal-gallery-scroll">`;
        items.forEach((itemSrc, idx) => {
          const isVid = isVideoUrl(itemSrc);
          galleryHtml += `<div class="gallery-card-item" draggable="${EDIT_MODE}" data-index="${idx}" style="position: relative;">`;
          galleryHtml += `<button type="button" class="delete-gallery-item-btn" title="מחק דימוי זה">×</button>`;
          if (isVid) {
            galleryHtml += `
              <video src="${itemSrc}" autoplay loop muted playsinline preload="auto">
                Your browser does not support video play.
              </video>
            `;
          } else {
            galleryHtml += `<img src="${itemSrc}" alt="${data.title} ${idx + 1}">`;
          }
          galleryHtml += `</div>`;
        });
        galleryHtml += `</div>`;
        modalMediaWrapper.innerHTML = galleryHtml + dropzoneHtml;
        relocateModalTools();
        schedulePlateFit();
        scheduleCaptionAlign();
        bindGalleryDeleteButtons(data, items);

        // DRAG AND DROP SWAP REORDERING FOR ITEMS INSIDE THE PROJECT MODAL
        const galleryCardItems = modalMediaWrapper.querySelectorAll('.gallery-card-item');
        let draggedGalleryIdx = null;

        galleryCardItems.forEach((gItem) => {
          gItem.addEventListener('dragstart', (e) => {
            if (!EDIT_MODE) return;
            draggedGalleryIdx = parseInt(gItem.getAttribute('data-index'), 10);
            e.dataTransfer.setData('text/plain', draggedGalleryIdx);
            e.dataTransfer.effectAllowed = 'move';
            gItem.classList.add('card-dragging');
          });

          gItem.addEventListener('dragend', () => {
            gItem.classList.remove('card-dragging');
            galleryCardItems.forEach(el => el.classList.remove('card-drag-over'));
            setTimeout(() => {
              draggedGalleryIdx = null;
            }, 200);
          });

          gItem.addEventListener('dragover', (e) => {
            e.preventDefault();
            const isFile = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
            if (isFile) {
              e.dataTransfer.dropEffect = 'copy';
              gItem.classList.add('card-file-hover');
            } else {
              e.dataTransfer.dropEffect = 'move';
              gItem.classList.add('card-drag-over');
            }
          });

          gItem.addEventListener('dragleave', () => {
            gItem.classList.remove('card-drag-over');
            gItem.classList.remove('card-file-hover');
          });

          gItem.addEventListener('drop', async (e) => {
            if (!EDIT_MODE) return;
            e.preventDefault();
            e.stopPropagation();
            gItem.classList.remove('card-drag-over');
            gItem.classList.remove('card-file-hover');

            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              await handleDropFilesInsideModal(Array.from(e.dataTransfer.files), data);
              return;
            }

            const rawFrom = draggedGalleryIdx !== null ? draggedGalleryIdx : parseInt(e.dataTransfer.getData('text/plain'), 10);
            const toIdx = parseInt(gItem.getAttribute('data-index'), 10);

            if (isNaN(rawFrom) || isNaN(toIdx) || rawFrom === toIdx) return;

            // DIRECT SWAP BETWEEN THE TWO ITEMS INSIDE THE PROJECT!
            const temp = items[rawFrom];
            items[rawFrom] = items[toIdx];
            items[toIdx] = temp;

            data.gallery = [...items];
            data.asset = '';
            data.videoAsset = '';
            data.isVideo = false;
            
            if (items.length > 0 && isVideoUrl(items[0])) {
              data.videoAsset = items[0];
              data.isVideo = true;
            } else if (items.length > 0) {
              data.asset = items[0];
            }

            const pIdx = projects.findIndex(p => p.id === data.id);
            if (pIdx !== -1) {
              projects[pIdx] = { ...data };
              await saveProjectsData();
              renderPortfolio();
            }

            openProjectModal(data);
            showToast(`🔄 Swapped item #${rawFrom + 1} ↔ item #${toIdx + 1} inside project!`);
          });
        });
      }

      // Wire up the interactive dropzone inside the modal
      const dropzone = modalMediaWrapper.querySelector('#modal-gallery-dropzone');
      const dropInput = modalMediaWrapper.querySelector('#modal-dropzone-file-input');
      if (dropzone && dropInput) {
        dropzone.addEventListener('click', () => {
          dropInput.click();
        });

        dropInput.addEventListener('change', async () => {
          if (dropInput.files && dropInput.files.length > 0) {
            await handleDropFilesInsideModal(Array.from(dropInput.files), data);
          }
        });

        dropzone.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          dropzone.classList.add('drag-over');
        });

        dropzone.addEventListener('dragleave', () => {
          dropzone.classList.remove('drag-over');
        });

        dropzone.addEventListener('drop', async (e) => {
          if (!EDIT_MODE) return;
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('drag-over');
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            await handleDropFilesInsideModal(Array.from(e.dataTransfer.files), data);
          }
        });
      }

      const attachExistingBtn = modalMediaWrapper.querySelector('#modal-attach-existing-btn');
      if (attachExistingBtn) {
        attachExistingBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openProjectPickerModal(data);
        });
      }

      // Wire up the entire modal-card so dragging anywhere in the modal works
      const modalCard = document.querySelector('#project-modal .modal-card');
      if (modalCard && !modalCard._dragBound) {
        modalCard._dragBound = true;
        let modalDragCounter = 0;

        modalCard.addEventListener('dragenter', (e) => {
          const isFile = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
          if (isFile) {
            e.preventDefault();
            modalDragCounter++;
            modalCard.classList.add('modal-file-hover');
          }
        });

        modalCard.addEventListener('dragover', (e) => {
          const isFile = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
          if (isFile) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            modalCard.classList.add('modal-file-hover');
          }
        });

        modalCard.addEventListener('dragleave', (e) => {
          modalDragCounter--;
          if (modalDragCounter <= 0) {
            modalDragCounter = 0;
            modalCard.classList.remove('modal-file-hover');
          }
        });

        modalCard.addEventListener('drop', async (e) => {
          if (!EDIT_MODE) return;
          modalDragCounter = 0;
          modalCard.classList.remove('modal-file-hover');
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0 && currentModalProject) {
            e.preventDefault();
            e.stopPropagation();
            await handleDropFilesInsideModal(Array.from(e.dataTransfer.files), currentModalProject);
          }
        });
      }

      // AUTO PLAY / PAUSE ON SCROLL: Observe videos inside modal so visible video plays and hidden videos pause!
      if (window.modalVideoObserver) {
        window.modalVideoObserver.disconnect();
      }

      const modalVideos = modalMediaWrapper.querySelectorAll('video');
      if (modalVideos.length > 0) {
        const modalScrollContainer = document.querySelector('#project-modal .modal-card') || null;
        
        window.modalVideoObserver = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            const video = entry.target;
            if (entry.isIntersecting) {
              // Active video visible in scroll view -> Play animation!
              video.play().catch(() => {
                modalSoundOn = false;
                video.muted = true;
                video.play().catch(() => {});
              });
            } else {
              // Video scrolled out of view -> Pause!
              video.pause();
            }
          });
        }, {
          root: modalScrollContainer,
          threshold: 0.55 // 55% visible threshold
        });

        // Only the first clip speaks — several at once would talk over each
        // other. The observer's play() falls back to silent if the browser
        // refuses sound, and the first click on the project then turns it on.
        modalVideos.forEach(v => {
          applyClipSpeed(v, data);
          window.modalVideoObserver.observe(v);
        });
        applyModalVoice();
        settleModalVoice();
      }
    }

    modalOverlay.classList.add('active');
  }

  // ------------------------------------------------------------------------
  // PROJECT SOUND
  // A project with sound plays it as soon as it opens; opening is itself a
  // click, so the browser allows it (if it ever refuses, the clip falls back
  // to silent rather than not playing at all). Clicking anywhere on the
  // project toggles the mute. A clip with no audio track is not "sound", so
  // on those projects a click keeps its old meaning.
  // ------------------------------------------------------------------------
  // media-audio.json (written by audio_map.py from each file's own track
  // list) says up front which clips carry sound, so the right clip is
  // unmuted before its first frame and the sound starts with the picture.
  // A clip added since the map was made falls back to what the browser can
  // tell once it has decoded some of it.
  let MEDIA_AUDIO = {};
  fetch('media-audio.json', { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : {}))
    .then(m => { MEDIA_AUDIO = m || {}; })
    .catch(() => {});

  function mediaKey(src) {
    let k = String(src || '');
    try { k = decodeURIComponent(k); } catch (e) {}
    return k.replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+\//, '').replace(/^(\.\/|\/)+/, '');
  }

  function hasSound(v) {
    const known = MEDIA_AUDIO[mediaKey(v.getAttribute('src') || v.currentSrc)];
    if (typeof known === 'boolean') return known;
    if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
    if (v.audioTracks && typeof v.audioTracks.length === 'number') return v.audioTracks.length > 0;
    if (typeof v.webkitAudioDecodedByteCount === 'number') {
      // Chrome/Safari only know once audio has been decoded; until the clip
      // has run a moment, assume it may have some.
      return v.webkitAudioDecodedByteCount > 0 || v.currentTime < 0.5;
    }
    return true;
  }

  // The voice is the first clip that actually carries audio; every other clip
  // stays silent so a gallery never talks over itself. Until the browser has
  // decoded a moment of each clip it cannot tell, so this is settled again
  // once they have run (settleModalVoice), and the sound moves to the right
  // clip without the viewer doing anything.
  let modalSoundOn = true;

  function modalVoice() {
    if (!modalOverlay) return null;
    const vids = Array.from(modalOverlay.querySelectorAll('#modal-media-wrapper video'));
    return vids.find(hasSound) || null;
  }

  function applyModalVoice() {
    const voice = modalVoice();
    modalOverlay.querySelectorAll('#modal-media-wrapper video').forEach(v => {
      v.muted = v !== voice || !modalSoundOn;
    });
    return voice;
  }

  function settleModalVoice() {
    [700, 1600, 3200].forEach(ms => setTimeout(() => {
      if (modalOverlay.classList.contains('active')) applyModalVoice();
    }, ms));
  }

  function playWithSound(v) {
    v.muted = false;
    const p = v.play();
    // Refused sound (no click behind the open): play silent instead, and let
    // the first click on the project be the one that turns it on.
    if (p && p.catch) p.catch(() => { modalSoundOn = false; v.muted = true; v.play().catch(() => {}); });
  }

  function toggleModalSound() {
    const v = modalVoice();
    if (!v) return false;
    // Read the state off the clip itself, so a browser that refused sound on
    // open is switched ON by the first click rather than "muted" again.
    modalSoundOn = v.muted;
    applyModalVoice();
    if (!v.muted && v.paused) v.play().catch(() => {});
    showToast(v.muted ? '🔇 Muted' : '🔊 Sound on');
    return true;
  }

  function closeModal() {
    if (window.modalVideoObserver) {
      window.modalVideoObserver.disconnect();
      window.modalVideoObserver = null;
    }
    if (modalOverlay) {
      const vids = modalOverlay.querySelectorAll('video');
      vids.forEach(v => {
        v.pause();
        v.currentTime = 0;
      });
      modalOverlay.classList.remove('active');
    }
  }

  // DYNAMIC SPATIAL TINY ARROWS INDICATORS FOR PREV & NEXT REMAINING PROJECTS
  function updateTinyArrowsIndicators(currentIndex, totalCount) {
    const tinyAbove = document.getElementById('tiny-arrows-above');
    const tinyBelow = document.getElementById('tiny-arrows-below');

    if (!tinyAbove || !tinyBelow) return;

    const countAbove = currentIndex;
    const countBelow = totalCount - 1 - currentIndex;

    let aboveHtml = '';
    for (let i = 0; i < countAbove; i++) {
      aboveHtml += `<span class="tiny-chevron tiny-up-chevron" title="${countAbove - i} project(s) above">‹</span>`;
    }
    tinyAbove.innerHTML = aboveHtml;

    let belowHtml = '';
    for (let i = 0; i < countBelow; i++) {
      belowHtml += `<span class="tiny-chevron tiny-down-chevron" title="${i + 1} project(s) below until end of site">‹</span>`;
    }
    tinyBelow.innerHTML = belowHtml;
  }

  // PROJECT NAVIGATION USING YELLOW ARROW BUTTONS (STYLE MATCHING USER IMAGE)
  const modalPrevBtn = document.getElementById('modal-prev-project-btn');
  const modalNextBtn = document.getElementById('modal-next-project-btn');

  function navigateProject(direction) {
    if (!currentModalProject || !projects || projects.length === 0) return;
    const currentIdx = projects.findIndex(p => p.id === currentModalProject.id);
    if (currentIdx === -1) return;

    let targetIdx;
    if (direction === 'next') {
      targetIdx = (currentIdx + 1) % projects.length;
    } else {
      targetIdx = (currentIdx - 1 + projects.length) % projects.length;
    }

    const nextProject = projects[targetIdx];
    if (nextProject) {
      // ELEVATOR MOTION APPLIED ONLY TO THE RIGHT ARROW BUTTONS
      const targetBtn = direction === 'next' ? modalNextBtn : modalPrevBtn;
      const animClass = direction === 'next' ? 'arrow-elevator-down' : 'arrow-elevator-up';

      if (targetBtn) {
        targetBtn.classList.remove('arrow-elevator-up', 'arrow-elevator-down');
        void targetBtn.offsetWidth; // Trigger reflow for instant animation restart
        targetBtn.classList.add(animClass);

        setTimeout(() => {
          targetBtn.classList.remove('arrow-elevator-up', 'arrow-elevator-down');
        }, 420);
      }

      // SMOOTH SYNCHRONOUS CROSSFADE: DISSOLVE OUT -> SWAP TEXT & VIDEO TOGETHER -> DISSOLVE IN
      const splitContainer = document.querySelector('#project-modal .modal-split-container');
      if (splitContainer) {
        splitContainer.style.transition = 'opacity 0.08s ease-out';
        splitContainer.style.opacity = '0';

        setTimeout(() => {
          openProjectModal(nextProject);
          requestAnimationFrame(() => {
            splitContainer.style.transition = 'opacity 0.14s ease-in';
            splitContainer.style.opacity = '1';
          });
        }, 75);
      } else {
        openProjectModal(nextProject);
      }

    }
  }

  if (modalPrevBtn) {
    modalPrevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateProject('prev');
    });
  }

  if (modalNextBtn) {
    modalNextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateProject('next');
    });
  }

  // ------------------------------------------------------------------------
  // CLICKS INSIDE A PROJECT
  //   the work itself  -> mute / unmute (on a project with sound)
  //   the text         -> its own handler opens the editor
  //   controls, fields -> their own job
  //   any black area   -> back to the home page
  // ------------------------------------------------------------------------
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('button, input, textarea, select, a, label, .modal-tools, .modal-edit-actions, .modal-caption-edit')) return;
      if (t.closest('#modal-media-wrapper img, #modal-media-wrapper video, .gallery-card-item')) {
        toggleModalSound();
        return;
      }
      if (t.closest('.modal-caption-view, .modal-caption-emblem')) return;
      closeModal();
    });
  }

  // KEYBOARD ARROW NAVIGATION (UP/LEFT = PREVIOUS, DOWN/RIGHT = NEXT, ESC = CLOSE)
  // ------------------------------------------------------------------------
  // KEYS BELONG TO WHATEVER IS BEING TYPED IN
  // Every global shortcut on this page was listening on window or document
  // with no regard for where the keystroke came from. With a project open,
  // an arrow key inside the description jumped to another project — losing
  // whatever had just been pasted — and a digit switched the composition
  // behind the modal. A field has first claim on its own keys.
  // ------------------------------------------------------------------------
  function isTypingTarget(e) {
    const el = e.target;
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' ||
           el.isContentEditable === true;
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e)) return;
    if (modalOverlay && modalOverlay.classList.contains('active')) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        navigateProject('prev');
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        navigateProject('next');
      } else if (e.key === 'Escape') {
        closeModal();
      }
    }
  });

  // CLICK OUTSIDE PROJECT TAB BACKDROP -> INSTANTLY CLOSE MODAL TO RETURN TO MAIN SCREEN
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      const modalContent = modalOverlay.querySelector('.modal-card');
      if (e.target === modalOverlay || (modalContent && !modalContent.contains(e.target))) {
        closeModal();
      }
    });
  }

  if (cardEditorModal) {
    cardEditorModal.addEventListener('click', (e) => {
      const editorContent = cardEditorModal.querySelector('.editor-modal-card');
      if (e.target === cardEditorModal || (editorContent && !editorContent.contains(e.target))) {
        closeCardEditor();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    // Escape inside a field leaves the field; it does not throw the project
    // away with the edit still in it.
    if (isTypingTarget(e)) return;
    if (e.key === 'Escape') {
      closeModal();
      closeCardEditor();
    }
  });

  // ------------------------------------------------------------------------
  // SHOWREEL REVEAL — the reel stays out of sight until the page is scrolled,
  // then rises into a full-bleed band. Revealing is one-way: once it is up it
  // stays up, so it does not flicker on every small scroll.
  // ------------------------------------------------------------------------
  const showreelSection = document.getElementById('showreel');
  const worksRail = document.getElementById('works-rail');

  // Stage 0: hero alone.  Stage 1: the reel rises and takes the screen.
  // Stage 2: the works come up as their own panel.
  // Stages only ever advance, so a small scroll never knocks the page back.
  let stage = 0;

  // Stages move in BOTH directions — scrolling back up walks the panels off
  // again, works -> reel -> hero, rather than trapping you at the bottom.
  function setStage(next) {
    next = Math.max(0, Math.min(2, next));
    if (next === stage) return;
    stage = next;

    const wantReel = stage >= 1;
    const wantWorks = stage >= 2;
    if (wantWorks) {
      // after the panel has travelled, so the numbers are where they land
      setTimeout(() => window.dispatchEvent(new Event('mihal:stage-works')), 60);
      setTimeout(() => window.dispatchEvent(new Event('mihal:stage-works')), 900);
    }

    if (showreelSection) showreelSection.classList.toggle('reel-revealed', wantReel);
    document.body.classList.toggle('stage-reel', wantReel);
    document.body.classList.toggle('stage-works', wantWorks);

    // The reel runs only while it is the panel you are on, and every arrival
    // starts it at the top — whether you came down from the hero or back up
    // from the works.
    if (wantReel && !wantWorks) restartShowreel();
    else stopShowreel();

    if (wantWorks && worksRail) {
      // Always open the rail at its head, however far it was scrolled last
      // time the works were up.
      worksRail.scrollLeft = 0;
    }
  }

  // While a stage is still collapsed the document may not be tall enough to
  // scroll at all, so intent is taken from the wheel/touch as well as scrollY.
  // ONE STAGE PER GESTURE.
  // A hard flick on a trackpad fires a long burst of wheel events; simply
  // totalling them let a single throw blow straight past the reel into the
  // works. Two guards stop that:
  //   1. after a stage lands, intent is ignored until the panel has finished
  //      travelling — momentum from the same flick is discarded, not banked;
  //   2. the next stage needs a genuinely new gesture, i.e. the wheel has to
  //      go quiet first.
  // Matches --panel-travel in the stylesheet.
  const PANEL_TRAVEL_MS = 950;
  const GESTURE_GAP_MS = 200;
  // Input reopens a little before the panel has fully settled. Held for the
  // whole travel, the page felt dead under your hand — which is most of what
  // made moving between the sections awkward.
  const INPUT_LOCK_MS = Math.round(PANEL_TRAVEL_MS * 0.72);
  // How far the incoming panel leans while you are still pushing.
  const NUDGE_MAX_PX = 26;

  let wheelTravel = 0;
  let lockedUntil = 0;
  let lastIntentAt = 0;
  let awaitingNewGesture = false;
  let nudgeClearTimer = 0;

  // THE PAGE ANSWERS YOUR HAND.
  // Nothing used to move until a stage flipped outright, so every transition
  // arrived out of nowhere. The incoming panel now leans in proportion to how
  // far through the gesture you are, and lets go the instant it commits.
  function setNudge(px) {
    document.documentElement.style.setProperty('--stage-nudge', px.toFixed(1) + 'px');
    document.body.classList.toggle('gesture-live', px > 0.5);
    clearTimeout(nudgeClearTimer);
    if (px > 0.5) nudgeClearTimer = setTimeout(() => setNudge(0), 220);
  }

  function releaseNudge() {
    clearTimeout(nudgeClearTimer);
    document.documentElement.style.setProperty('--stage-nudge', '0px');
    document.body.classList.remove('gesture-live');
  }

  function advanceOnIntent(amount) {
    if (amount === 0) return;

    const t = performance.now();

    // still animating: swallow the leftover momentum entirely
    if (t < lockedUntil) {
      wheelTravel = 0;
      awaitingNewGesture = true;
      lastIntentAt = t;
      return;
    }

    // a stage just landed — wait for the flick to actually stop
    if (awaitingNewGesture) {
      if (t - lastIntentAt < GESTURE_GAP_MS) {
        lastIntentAt = t;
        return;
      }
      awaitingNewGesture = false;
      wheelTravel = 0;
    }

    // A pause BLEEDS the count off; it does not wipe it. Wiping it meant that
    // scrolling gently — a wheel notch every third of a second — reset the
    // total every single time and could never reach the threshold, so the
    // page simply refused to move for anyone who did not flick at it.
    wheelTravel *= Math.exp(-(t - lastIntentAt) / 700);
    if (wheelTravel !== 0 && Math.sign(wheelTravel) !== Math.sign(amount)) wheelTravel = 0;
    lastIntentAt = t;

    wheelTravel += amount;

    const down = wheelTravel > 0;
    // A single wheel notch used to be enough to leave the hero, so the first
    // section fell away at a twitch. Every step is now a deliberate push.
    const threshold = down ? 130 : 150;

    if (Math.abs(wheelTravel) > threshold) {
      const next = stage + (down ? 1 : -1);
      if (next >= 0 && next <= 2) {
        releaseNudge();
        setStage(next);
        wheelTravel = 0;
        lockedUntil = t + INPUT_LOCK_MS;
        awaitingNewGesture = true;
      } else {
        wheelTravel = 0;
        releaseNudge();
      }
      return;
    }

    // below the threshold: show the push building, but only for the direction
    // that has somewhere to go
    const wantsNext = down ? stage < 2 : false;
    setNudge(wantsNext ? Math.min(1, Math.abs(wheelTravel) / threshold) * NUDGE_MAX_PX : 0);
  }

  // THE RAIL TAKES THE WHEEL FIRST.
  // While the works are up, a vertical wheel runs the rail sideways. Only once
  // the rail is back at its head does a further backward pull reach the stage
  // machine and walk the panel off — the ordinary scroll-chaining you expect,
  // rather than the rail and the stage both reacting to the same flick.
  function railTakesWheel(delta) {
    if (stage < 2 || !worksRail) return false;
    // The rail is checked BEFORE the stage machine, so it has to honour the
    // same lock: otherwise the tail of the very flick that brought the works
    // up runs straight on into the rail and it arrives already scrolled.
    if (performance.now() < lockedUntil) return true;
    const max = worksRail.scrollWidth - worksRail.clientWidth;
    if (max <= 1) return false;
    const atHead = worksRail.scrollLeft <= 0.5;
    const atTail = worksRail.scrollLeft >= max - 0.5;
    if (delta < 0 && atHead) return false;   // pulling back past the start
    if (delta > 0 && atTail) return false;   // pushing on past the end
    worksRail.scrollLeft += delta;
    return true;
  }

  // ONE AXIS PER GESTURE.
  // A sideways gesture only ever drives the works row: however fast, and even
  // once the row has hit its end, it never reaches the panels — before, the
  // small up/down drift in a quick sideways trackpad swipe went on to the
  // stage machine the moment the row ran out, added up, and threw the page
  // back up a panel. Only an up/down gesture moves between panels.
  // The row is scrolled here and only here (the browser's own sideways
  // scroll is held back), so it can't be moved twice by one swipe.
  // While a project or the CV is open, they scroll themselves and the
  // panels behind them stay put.
  const overlayOpen = () => !!document.querySelector('.modal-overlay.active, .cv-page.active');

  window.addEventListener('wheel', (e) => {
    if (overlayOpen()) return;
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (sideways) {
      e.preventDefault();                 // also stops the browser's back-swipe
      if (stage === 2 && worksRail && performance.now() >= lockedUntil) {
        worksRail.scrollLeft += e.deltaX;
      }
      return;
    }
    if (railTakesWheel(e.deltaY)) { e.preventDefault(); return; }
    advanceOnIntent(e.deltaY);
  }, { passive: false });

  // Touch: the axis is decided by the first few pixels of the drag and held
  // for the rest of it. A sideways drag is left to the row's own native
  // scrolling and never counts towards changing panel.
  let lastTouchY = null, touchStartX = 0, touchStartY = 0, touchAxis = null;
  window.addEventListener('touchstart', (e) => {
    if (!e.touches.length) { lastTouchY = null; return; }
    lastTouchY = touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchAxis = null;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (lastTouchY === null || !e.touches.length || overlayOpen()) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    if (!touchAxis) {
      const dx = Math.abs(x - touchStartX), dy = Math.abs(y - touchStartY);
      if (dx < 8 && dy < 8) return;
      touchAxis = dx > dy ? 'x' : 'y';
    }
    if (touchAxis === 'x') return;
    const delta = lastTouchY - y;
    lastTouchY = y;
    // On a phone the works panel is taller than the screen (one column of
    // titles with full-size tap rows), so an up/down drag scrolls it natively.
    // Only a pull down from its very top goes back to the showreel.
    if (stage === 2) {
      const sec = document.getElementById('portfolio-grid');
      if (sec && sec.scrollHeight - sec.clientHeight > 2) {
        if (sec.scrollTop > 0 || delta > 0) return;
        advanceOnIntent(delta);
        return;
      }
    }
    if (railTakesWheel(delta)) return;
    advanceOnIntent(delta);
  }, { passive: true });

  // Keys move between the panels directly (the document itself no longer
  // scrolls, so they can't reach them through a scroll any more). Not while
  // typing, and not while a project or the CV is open — those have their own.
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-overlay.active, .cv-page.active')) return;
    const fwd = e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey);
    const back = e.key === 'ArrowUp' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey);
    if (!fwd && !back) return;
    if (performance.now() < lockedUntil) return;
    const next = stage + (fwd ? 1 : -1);
    if (next < 0 || next > 2) return;
    e.preventDefault();
    releaseNudge();
    setStage(next);
    lockedUntil = performance.now() + INPUT_LOCK_MS;
  });

  // Scrolling the document counts as intent too, but goes through the same
  // gate so it can never skip a stage either. (The document is locked now,
  // so this only matters if something ever makes it scrollable again.)
  let lastScrollY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    advanceOnIntent(y - lastScrollY);
    lastScrollY = y;
  }, { passive: true });

  // ------------------------------------------------------------------------
  // CV PANEL — opens the PDF inside the site rather than downloading it.
  // ------------------------------------------------------------------------
  const heroCvLink = document.getElementById('hero-cv-link');
  const cvModal = document.getElementById('cv-modal');
  const cvModalBody = document.getElementById('cv-modal-body');
  const cvModalCloseBtn = document.getElementById('cv-modal-close-btn');

  // The CV is a page of this site, written in its own language — no PDF is
  // fetched, embedded or downloaded. The markup is already in the document;
  // opening it is just a class.
  function openCvModal() {
    if (!cvModal) return;
    cvModal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeCvModal() {
    if (!cvModal) return;
    cvModal.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (heroCvLink) heroCvLink.addEventListener('click', openCvModal);
  if (cvModalCloseBtn) cvModalCloseBtn.addEventListener('click', closeCvModal);
  // "Projects" in the CV's bar is the other room of the site: leaving the CV
  // is going back to it.
  // It lands straight on the works panel — whatever panel was behind the CV —
  // and holds the page there while the panel travels, so leftover wheel
  // momentum cannot carry it back off.
  const cvBackProjects = document.getElementById('cv-back-projects');
  if (cvBackProjects) cvBackProjects.addEventListener('click', () => {
    closeCvModal();
    lockedUntil = performance.now() + PANEL_TRAVEL_MS;
    setStage(2);
  });
  if (cvModal) {
    cvModal.addEventListener('click', (e) => {
      if (e.target === cvModal) closeCvModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e)) return;
    if (e.key === 'Escape') closeCvModal();
  });

  // ------------------------------------------------------------------------
  // 7. TOAST NOTIFICATION SYSTEM
  // ------------------------------------------------------------------------
  const toast = document.getElementById('toast-notification');
  let toastTimer = null;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  // AUTO-MUTE SHOWREEL MUSIC ONCE THE USER SCROLLS PAST THE HERO
  window.addEventListener('scroll', () => {
    const mainReel = document.getElementById('main-showreel');
    const mainMuteBtn = document.getElementById('mute-btn');
    if (mainReel) {
      if (window.scrollY > 200) {
        if (!mainReel.muted) {
          mainReel.muted = true;
          paintReelSound(mainMuteBtn, true);
        }
      }
    }
  });

  // ------------------------------------------------------------------------
  // 8. DRAG & DROP FILE UPLOADER ENGINE (GLOBAL & BACKGROUND ZONE)
  // ------------------------------------------------------------------------
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  async function handleDroppedFile(file, insertAfterId = null) {
    if (!file) return;
    const isVid = file.type.startsWith('video/') || isVideoUrl(file.name);
    
    showToast(`📥 מעלה ושומר ${file.name}...`);

    const aspect = await detectFileAspectRatio(file);
    const savedPath = await uploadFileToSiteFolder(file);

    const existing = projects.find(p => (p.videoAsset && p.videoAsset === savedPath) || (p.asset && p.asset === savedPath));
    if (existing) {
      showToast(`ℹ️ הפרויקט "${existing.title}" כבר קיים בפורטפוליו!`);
      return;
    }

    const cleanTitle = file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');

    const newProj = {
      id: `work-${Date.now()}`,
      title: cleanTitle,
      subtitle: 'Uploaded Project',
      category: 'Motion & Screen Graphics',
      catTag: 'motion',
      year: '',
      client: '',
      role: '',
      toolkit: '',
      asset: isVid ? '' : savedPath,
      videoAsset: isVid ? savedPath : '',
      isVideo: isVid,
      aspectRatio: aspect,
      gallery: [savedPath],
      description: `Project work "${cleanTitle}" uploaded to portfolio.`
    };

    if (insertAfterId) {
      const afterIdx = projects.findIndex(p => p.id === insertAfterId);
      if (afterIdx !== -1) {
        projects.splice(afterIdx + 1, 0, newProj);
      } else {
        projects.push(newProj);
      }
    } else {
      projects.push(newProj);
    }

    await saveProjectsData();
    renderPortfolio();
    showToast(`✨ נוצר ונשמר פרויקט חדש: "${cleanTitle}"!`);
  }

  async function handleDroppedMultipleFiles(files) {
    if (!files || files.length === 0) return;
    showToast(`📥 מעלה ${files.length} קבצים כפרויקט חדש...`);

    const uploadedPaths = [];
    let detectedAspect = '3/4';

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        if (i === 0) {
          const asp = await detectFileAspectRatio(file);
          if (asp) detectedAspect = asp;
        }
        const savedPath = await uploadFileToSiteFolder(file);
        if (savedPath) uploadedPaths.push(savedPath);
      } catch (e) {
        console.error('Error uploading file:', file.name, e);
      }
    }

    if (uploadedPaths.length === 0) {
      showToast('⚠️ העלאת הקבצים נכשלה.');
      return;
    }

    const firstPath = uploadedPaths[0];
    const firstIsVid = isVideoUrl(firstPath);
    const cleanTitle = files[0].name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');

    const newProj = {
      id: `work-${Date.now()}`,
      title: cleanTitle,
      subtitle: 'Uploaded Project',
      category: 'Motion & Screen Graphics',
      catTag: 'motion',
      year: '',
      client: '',
      role: '',
      toolkit: '',
      asset: isVid ? '' : firstPath,
      videoAsset: isVid ? firstPath : '',
      isVideo: isVid,
      aspectRatio: detectedAspect,
      gallery: uploadedPaths,
      description: `Project work "${cleanTitle}" uploaded to portfolio.`
    };

    projects.push(newProj);
    await saveProjectsData();
    renderPortfolio();
    showToast(`✨ נוצר פרויקט חדש עם ${uploadedPaths.length} קבצים בגלריה הפנימית!`);
  }

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!EDIT_MODE) return;   // a file dropped on the live site does nothing

    // If detail modal is currently open, route dropped files into the active project!
    if (modalOverlay && modalOverlay.classList.contains('active') && currentModalProject) {
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await handleDropFilesInsideModal(Array.from(e.dataTransfer.files), currentModalProject);
      }
      return;
    }

    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 1) {
        await handleDroppedFile(files[0]);
      } else {
        await handleDroppedMultipleFiles(files);
      }
    }
  });

  // Modal Drag Zone Hook
  const modalDragDropZone = document.getElementById('modal-drag-drop-zone');
  if (modalDragDropZone) {
    ['dragenter', 'dragover'].forEach(eventName => {
      modalDragDropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        modalDragDropZone.classList.add('drag-over');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      modalDragDropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        modalDragDropZone.classList.remove('drag-over');
      }, false);
    });

    modalDragDropZone.addEventListener('drop', async (e) => {
      if (!EDIT_MODE) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        showToast(`Uploading ${files.length} dropped file(s)...`);
        const uploadedPaths = [];
        
        for (const file of files) {
          const isVid = file.type.startsWith('video/') || isVideoUrl(file.name);
          const savedPath = await uploadFileToSiteFolder(file);
          if (savedPath) {
            uploadedPaths.push(savedPath);
            if (isVid && editProjectVideoUrl && !editProjectVideoUrl.value.trim()) {
              editProjectVideoUrl.value = savedPath;
            } else if (!isVid && editProjectAssetUrl && !editProjectAssetUrl.value.trim()) {
              editProjectAssetUrl.value = savedPath;
            }
          }
        }

        if (editGalleryUrls && uploadedPaths.length > 0) {
          const existing = editGalleryUrls.value.trim() ? editGalleryUrls.value.split(',').map(s=>s.trim()).filter(Boolean) : [];
          const combined = Array.from(new Set([...existing, ...uploadedPaths]));
          editGalleryUrls.value = combined.join(', ');
        }

        showToast(`✓ Dropped & attached ${uploadedPaths.length} file(s)! Click SAVE PERMANENTLY.`);
      }
    });
  }

  // ------------------------------------------------------------------------
  // 9. DYNAMIC AMORPHOUS MORPHING ENGINE (Hero Vector Composition)
  // Inspired by Festival MV & Bio-Map (Atelier Tout Va Bien & Vanzyst)
  // Extreme Easy-Ease Kinematics: Anticipation -> Sudden Acceleration -> Smooth Landing
  // ------------------------------------------------------------------------
  function initHeroAmorphousMorph() {
    const svg = document.getElementById('amorphous-hero-svg');
    const wrap = document.getElementById('poster-hero-graphic-wrap');
    if (!svg) return;

    const blobPath = document.getElementById('morph-blob-path');
    const blobUnder = document.getElementById('morph-blob-under');
    const archesPath = document.getElementById('morph-arches-path');
    const ribbonPath = document.getElementById('morph-ribbon-path');
    const spokesGroup = document.getElementById('morph-spokes-group');
    const webGroup = document.getElementById('morph-web-group');
    const ringsGroup = document.getElementById('morph-rings-group');
    const satellitesGroup = document.getElementById('morph-satellites-group');
    const coreDot = document.getElementById('morph-core-dot');
    const coreRing = document.getElementById('morph-core-ring');
    const coreRingOuter = document.getElementById('morph-core-ring-outer');

    // ------------------------------------------------------------------
    // THE FIELD: FOURTEEN FORMS, FOUR ARRANGEMENTS
    //
    // Each form keeps its identity for good. Slot 1 is always the long thin
    // bar, slot 13 always the small round dot — a composition only says WHERE
    // each one stands and how big it is there, never what it is. That is what
    // makes the travel between arrangements readable: you watch the same
    // fourteen things walk to new positions instead of a field of blobs
    // dissolving into a different field of blobs.
    //
    //  1 STREWN   forms scattered over the whole spread
    //  2 ROWS     ranked across three registers
    //  3 CLUSTER  bunched heavy in the middle with outliers hanging off
    //  4 CURRENT  a diagonal drift running low-left to high-right
    //
    // It advances on its own; keys 1-4 jump to one directly.
    // ------------------------------------------------------------------
    // The blobs' ink. One constant, read by the draw code and re-asserted on
    // every element, so there is exactly one place this value lives.
    const BLOB_FILL = '#b6c7ea';

    const SLOT_COUNT = 10;
    // The reference's masses fill their panel — a form there is a third of
    // the width, not a tenth. Nudged up towards that.
    // A bubble glyph is solid right out to its frame, where every earlier
    // form tapered away long before it. At the old numbers the fourteen of
    // them covered the canvas edge to edge with no ground left between.
    // A thing needs to be big enough to be recognised, and every form is
    // scaled to fit the same radius, so raising this costs ground evenly
    // rather than letting one shape swamp the canvas.
    // The masses are solid and large, the way the reference's is: it owns a
    // whole edge of the page. This is as far as it can go before they start
    // closing over one another.
    const FIELD_SCALE = 0.66;

    // The set is built to be legible at a glance: a huge mass next to a hair-
    // thin bar next to a small dot. Forms read as different from one another
    // because of SIZE and CONCAVITY, not because of a few percent of wobble —
    // fourteen rounded lumps of one size all look like the same lump.
    // `warp` is how organic the outline is: 0 leaves the geometric families
    // clean-edged, which is what makes the organic ones read as organic.
    // THE SYMBOLS.
    //
    // Hand-authored, not generated: each one is written out as explicit path
    // data, centred on the origin inside a 100-unit box, so a slot only ever
    // translates, turns and scales it. The silhouette that was drawn is the
    // silhouette that arrives on the page.
    //
    // One language across the whole set: a single solid mass per symbol, no
    // stroke anywhere, limbs that taper off the body and end round, corners
    // eased by the same amount everywhere, and a counter punched clean
    // through wherever the figure can carry one — the bow of the key, the
    // palm of the hand, the loop of the handle, the eyes. The counters are
    // cut with fill-rule evenodd, which is why a symbol and its counters
    // share one path string: fill-rule cannot see across elements.
    //
    // Each outline was drawn as a run of points and converted to cubics, so
    // every `d` below is explicit curve data and nothing is interpolated at
    // run time. Figurative where it helps them tell each other apart, but
    // reduced to the point where they read as marks rather than pictures.
    const GLYPHS = {
      // five arms that taper to a point and all lean the same way
      star: [
        'M 0 -50 C 0.4 -50, 4.2 -19, 5.4 -11.8 ' +
          'C 6.7 -4.6, 6.5 -7.6, 7.4 -6.7 C 8.4 -5.8, 4.5 -5.2, 11.2 -6.6 ' +
          'C 17.9 -8.1, 47.5 -15.9, 47.6 -15.5 ' +
          'C 47.6 -15, 19.4 -1.9, 12.9 1.5 C 6.4 4.9, 9.2 3.8, 8.7 5 ' +
          'C 8.1 6.2, 6.3 2.7, 9.8 8.6 C 13.2 14.5, 29.8 40.2, 29.4 40.5 ' +
          'C 29 40.7, 7.8 17.9, 2.5 12.7 C -2.7 7.6, -0.8 9.9, -2.1 9.8 ' +
          'C -3.4 9.6, -0.6 6.8, -5.1 11.9 ' +
          'C -9.7 17.1, -29.1 40.7, -29.4 40.5 ' +
          'C -29.7 40.2, -14.6 12.9, -11.3 6.4 ' +
          'C -8.1 -0.2, -9.7 2.3, -9.9 1 C -10.2 -0.2, -6.7 1.6, -12.9 -1.2 ' +
          'C -19.2 -3.9, -47.7 -15.1, -47.6 -15.5 ' +
          'C -47.4 -15.8, -16.8 -9.9, -9.6 -8.8 ' +
          'C -2.3 -7.8, -5.2 -8.5, -4.1 -9.1 ' +
          'C -3 -9.8, -3.5 -5.9, -2.9 -12.7 C -2.2 -19.5, -0.4 -50, 0 -50 Z'
      ],
      // an almond, the iris cut out of it and the pupil set back inside
      eye: [
        'M -47 0 C -47 -2.6, -31.1 -17.6, -24 -22 ' +
          'C -16.9 -26.4, -7.6 -29, 0 -29 C 7.6 -29, 16.9 -26.4, 24 -22 ' +
          'C 31.1 -17.6, 47 -2.6, 47 0 C 47 2.6, 31.1 17.6, 24 22 ' +
          'C 16.9 26.4, 7.6 29, 0 29 C -7.6 29, -16.9 26.4, -24 22 ' +
          'C -31.1 17.6, -47 2.6, -47 0 Z M 16 0 ' +
          'C 16 2.7, 14.5 7.2, 12.9 9.4 C 11.4 11.6, 7.5 14.4, 4.9 15.2 ' +
          'C 2.4 16, -2.4 16, -4.9 15.2 C -7.5 14.4, -11.4 11.6, -12.9 9.4 ' +
          'C -14.5 7.2, -16 2.7, -16 0 C -16 -2.7, -14.5 -7.2, -12.9 -9.4 ' +
          'C -11.4 -11.6, -7.5 -14.4, -4.9 -15.2 ' +
          'C -2.4 -16, 2.4 -16, 4.9 -15.2 ' +
          'C 7.5 -14.4, 11.4 -11.6, 12.9 -9.4 ' +
          'C 14.5 -7.2, 16 -2.7, 16 0 Z M 6.5 0 C 6.5 1.1, 5.9 2.9, 5.3 3.8 ' +
          'C 4.6 4.7, 3 5.8, 2 6.2 C 1 6.5, -1 6.5, -2 6.2 ' +
          'C -3 5.8, -4.6 4.7, -5.3 3.8 C -5.9 2.9, -6.5 1.1, -6.5 0 ' +
          'C -6.5 -1.1, -5.9 -2.9, -5.3 -3.8 C -4.6 -4.7, -3 -5.8, -2 -6.2 ' +
          'C -1 -6.5, 1 -6.5, 2 -6.2 C 3 -5.8, 4.6 -4.7, 5.3 -3.8 ' +
          'C 5.9 -2.9, 6.5 -1.1, 6.5 0 Z'
      ],
      // round bow with the counter punched through it, and two teeth
      key: [
        'M 6 -5.9 C 7.1 -7.1, 10.7 -7.8, 12.6 -9.2 ' +
          'C 14.6 -10.7, 16.4 -12.6, 17.7 -14.7 ' +
          'C 19 -16.8, 20 -19.2, 20.5 -21.6 C 21 -24, 21.1 -26.6, 20.8 -29 ' +
          'C 20.4 -31.4, 19.6 -34, 18.4 -36.1 ' +
          'C 17.2 -38.2, 15.6 -40.3, 13.7 -41.9 ' +
          'C 11.9 -43.5, 9.6 -44.8, 7.3 -45.7 C 5 -46.5, 2.4 -47, 0 -47 ' +
          'C -2.4 -47, -5 -46.5, -7.3 -45.7 ' +
          'C -9.6 -44.8, -11.9 -43.5, -13.7 -41.9 ' +
          'C -15.6 -40.3, -17.2 -38.2, -18.4 -36.1 ' +
          'C -19.6 -34, -20.4 -31.4, -20.8 -29 ' +
          'C -21.1 -26.6, -21 -24, -20.5 -21.6 ' +
          'C -20 -19.2, -19 -16.8, -17.7 -14.7 ' +
          'C -16.4 -12.6, -14.6 -10.7, -12.6 -9.2 ' +
          'C -10.7 -7.8, -7.1 -7.1, -6 -5.9 C -4.9 -4.7, -6 -3.1, -6 -2 ' +
          'C -6 -0.9, -6.2 37.5, -6 40 C -5.8 42.5, -3.8 46.4, -3 47 ' +
          'C -2.2 47.6, 2.2 47.6, 3 47 C 3.8 46.4, 5.8 40.5, 6 40 ' +
          'C 6.2 39.5, 3.8 38.3, 6 38 C 8.2 37.7, 18.4 38.4, 19 38 ' +
          'C 19.6 37.6, 19.6 30.4, 19 30 C 18.4 29.6, 6.7 30.2, 6 30 ' +
          'C 5.3 29.8, 3.2 25.8, 6 25 C 8.8 24.2, 22.1 25.4, 23 25 ' +
          'C 23.9 24.6, 23.9 16.4, 23 16 C 22.1 15.6, 6.8 16.9, 6 16 ' +
          'C 5.2 15.1, 6 -1.5, 6 -2 C 6 -2.5, 4.9 -4.7, 6 -5.9 Z M 8 -27 ' +
          'C 8 -25.1, 7 -22.7, 5.7 -21.3 C 4.3 -20, 1.9 -19, 0 -19 ' +
          'C -1.9 -19, -4.3 -20, -5.7 -21.3 C -7 -22.7, -8 -25.1, -8 -27 ' +
          'C -8 -28.9, -7 -31.3, -5.7 -32.7 C -4.3 -34, -1.9 -35, -0 -35 ' +
          'C 1.9 -35, 4.3 -34, 5.7 -32.7 C 7 -31.3, 8 -28.9, 8 -27 Z'
      ],
      // a jug whose handle carries the loop it is held by
      vessel: [
        'M -25 -42 C -25.8 -41.1, -27.8 -35.9, -27 -34 ' +
          'C -26.2 -32.1, -17.5 -28.8, -18 -26 ' +
          'C -18.5 -23.2, -28 -17.6, -31 -13 C -34 -8.3, -37.7 -0.9, -38 5 ' +
          'C -38.3 10.9, -36.6 20.9, -33 26 ' +
          'C -29.4 31.1, -19.9 37.2, -14 39 C -8.1 40.8, 0.6 39.8, 6 38 ' +
          'C 11.4 36.2, 18.9 31.5, 22 27 C 25.1 22.5, 27 12.9, 27 8 ' +
          'C 27 3, 20.7 -3.7, 22 -6 C 23.3 -8.3, 32.9 -6.4, 36 -8 ' +
          'C 39.1 -9.6, 44.4 -15.6, 45 -18 C 45.6 -20.4, 43.7 -30, 42 -32 ' +
          'C 40.3 -34, 31 -37.5, 28 -38 C 25 -38.5, 18.7 -37.2, 16 -36 ' +
          'C 13.3 -34.8, 9.2 -28.6, 8 -29 C 6.8 -29.4, 8.3 -37.4, 7 -39 ' +
          'C 5.7 -40.6, -2.2 -44.3, -5 -45 ' +
          'C -7.8 -45.7, -14.7 -45.4, -17 -45 ' +
          'C -19.3 -44.6, -24.2 -42.9, -25 -42 Z M 37.5 -21 ' +
          'C 37.5 -19.2, 36.6 -16.9, 35.3 -15.7 ' +
          'C 34.1 -14.4, 31.8 -13.5, 30 -13.5 ' +
          'C 28.2 -13.5, 25.9 -14.4, 24.7 -15.7 ' +
          'C 23.4 -16.9, 22.5 -19.2, 22.5 -21 ' +
          'C 22.5 -22.8, 23.4 -25.1, 24.7 -26.3 ' +
          'C 25.9 -27.6, 28.2 -28.5, 30 -28.5 ' +
          'C 31.8 -28.5, 34.1 -27.6, 35.3 -26.3 ' +
          'C 36.6 -25.1, 37.5 -22.8, 37.5 -21 Z'
      ],
      // a vertebral column: six vertebrae, sharp spurs off each, each one pierced
      spine: [
        'M 0 -50 C -3 -50, -7.8 -47.2, -9 -46.5 C -10.2 -45.8, -10.2 -44, -11.5 ' +
        '-43 C -12.8 -42, -24.6 -35, -24.6 -35 C -24.6 -35, -11.9 -38.1, -10.5 ' +
        '-38 C -9.1 -37.9, -8.6 -34.8, -8 -34.2 C -7.5 -33.6, -4.7 -32.8, -5 ' +
        '-32.4 C -5.3 -32, -9.2 -31.9, -10 -31.5 C -10.8 -31.1, -11 -29.1, ' +
        '-12.5 -28 C -14 -26.9, -27.8 -18.5, -27.8 -18.5 C -27.8 -18.5, -13.1 ' +
        '-22.9, -11.5 -23 C -9.9 -23.1, -9.7 -19.8, -9 -19.2 C -8.3 -18.6, -4.7 ' +
        '-17.8, -5 -17.4 C -5.3 -17, -10.2 -16.9, -11 -16.5 C -11.8 -16.1, ' +
        '-11.8 -14, -13.5 -13 C -15.2 -12, -31 -5, -31 -5 C -31 -5, -14.2 -8.1, ' +
        '-12.5 -8 C -10.8 -7.9, -10.8 -4.8, -10 -4.2 C -9.2 -3.6, -4.7 -2.8, -5 ' +
        '-2.4 C -5.3 -2, -11.1 -1.9, -12 -1.5 C -12.9 -1.1, -13 0.9, -14.5 2 C ' +
        '-16 3.1, -29.8 11.5, -29.8 11.5 C -29.8 11.5, -15.1 7.1, -13.5 7 C ' +
        '-11.9 6.9, -11.8 10.2, -11 10.8 C -10.2 11.4, -4.7 12.2, -5 12.6 C ' +
        '-5.3 13, -11.9 13.1, -13 13.5 C -14.1 13.9, -14.2 16, -15.5 17 C -16.8 ' +
        '18, -28.6 25, -28.6 25 C -28.6 25, -15.9 21.9, -14.5 22 C -13.1 22.1, ' +
        '-12.9 25.2, -12 25.8 C -11.1 26.4, -4.7 27.4, -5 27.6 C -5.3 27.8, ' +
        '-12.8 27.2, -14 27.5 C -15.2 27.8, -15.4 29.9, -16.5 31 C -17.6 32.1, ' +
        '-27.4 40.5, -27.4 40.5 C -27.4 40.5, -16.7 36.1, -15.5 36 C -14.3 ' +
        '35.9, -14.1 39.2, -13 39.8 C -11.9 40.4, -6.5 40.8, -5 41.6 C -3.5 ' +
        '42.4, -2.5 45.2, -2 46 C -1.5 46.8, 0 50, 0 50 C 0 50, 1.5 46.8, 2 46 ' +
        'C 2.5 45.2, 3.5 42.4, 5 41.6 C 6.5 40.8, 11.9 40.4, 13 39.8 C 14.1 ' +
        '39.2, 14.3 35.9, 15.5 36 C 16.7 36.1, 27.4 40.5, 27.4 40.5 C 27.4 ' +
        '40.5, 17.6 32.1, 16.5 31 C 15.4 29.9, 15.2 27.8, 14 27.5 C 12.8 27.2, ' +
        '5.3 27.8, 5 27.6 C 4.7 27.4, 11.1 26.4, 12 25.8 C 12.9 25.2, 13.1 ' +
        '22.1, 14.5 22 C 15.9 21.9, 28.6 25, 28.6 25 C 28.6 25, 16.8 18, 15.5 ' +
        '17 C 14.2 16, 14.1 13.9, 13 13.5 C 11.9 13.1, 5.3 13, 5 12.6 C 4.7 ' +
        '12.2, 10.2 11.4, 11 10.8 C 11.8 10.2, 11.9 6.9, 13.5 7 C 15.1 7.1, ' +
        '29.8 11.5, 29.8 11.5 C 29.8 11.5, 16 3.1, 14.5 2 C 13 0.9, 12.9 -1.1, ' +
        '12 -1.5 C 11.1 -1.9, 5.3 -2, 5 -2.4 C 4.7 -2.8, 9.2 -3.6, 10 -4.2 C ' +
        '10.8 -4.8, 10.8 -7.9, 12.5 -8 C 14.2 -8.1, 31 -5, 31 -5 C 31 -5, 15.2 ' +
        '-12, 13.5 -13 C 11.8 -14, 11.8 -16.1, 11 -16.5 C 10.2 -16.9, 5.3 -17, ' +
        '5 -17.4 C 4.7 -17.8, 8.3 -18.6, 9 -19.2 C 9.7 -19.8, 9.9 -23.1, 11.5 ' +
        '-23 C 13.1 -22.9, 27.8 -18.5, 27.8 -18.5 C 27.8 -18.5, 14 -26.9, 12.5 ' +
        '-28 C 11 -29.1, 10.8 -31.1, 10 -31.5 C 9.2 -31.9, 5.3 -32, 5 -32.4 C ' +
        '4.7 -32.8, 7.5 -33.6, 8 -34.2 C 8.6 -34.8, 9.1 -37.9, 10.5 -38 C 11.9 ' +
        '-38.1, 24.6 -35, 24.6 -35 C 24.6 -35, 12.8 -42, 11.5 -43 C 10.2 -44, ' +
        '10.2 -45.8, 9 -46.5 C 7.8 -47.2, 3 -50, 0 -50 Z M 3.6 -40.5 C 3.6 ' +
        '-39.9, 3.1 -39.2, 2.5 -38.8 C 1.9 -38.4, 0.8 -38.1, 0 -38.1 C -0.8 ' +
        '-38.1, -1.9 -38.4, -2.5 -38.8 C -3.1 -39.2, -3.6 -39.9, -3.6 -40.5 C ' +
        '-3.6 -41.1, -3.1 -41.8, -2.5 -42.2 C -1.9 -42.6, -0.8 -42.9, -0 -42.9 ' +
        'C 0.8 -42.9, 1.9 -42.6, 2.5 -42.2 C 3.1 -41.8, 3.6 -41.1, 3.6 -40.5 Z ' +
        'M 3.6 -25.5 C 3.6 -24.9, 3.1 -24.2, 2.5 -23.8 C 1.9 -23.4, 0.8 -23.1, ' +
        '0 -23.1 C -0.8 -23.1, -1.9 -23.4, -2.5 -23.8 C -3.1 -24.2, -3.6 -24.9, ' +
        '-3.6 -25.5 C -3.6 -26.1, -3.1 -26.8, -2.5 -27.2 C -1.9 -27.6, -0.8 ' +
        '-27.9, -0 -27.9 C 0.8 -27.9, 1.9 -27.6, 2.5 -27.2 C 3.1 -26.8, 3.6 ' +
        '-26.1, 3.6 -25.5 Z M 3.6 -10.5 C 3.6 -9.9, 3.1 -9.2, 2.5 -8.8 C 1.9 ' +
        '-8.4, 0.8 -8.1, 0 -8.1 C -0.8 -8.1, -1.9 -8.4, -2.5 -8.8 C -3.1 -9.2, ' +
        '-3.6 -9.9, -3.6 -10.5 C -3.6 -11.1, -3.1 -11.8, -2.5 -12.2 C -1.9 ' +
        '-12.6, -0.8 -12.9, -0 -12.9 C 0.8 -12.9, 1.9 -12.6, 2.5 -12.2 C 3.1 ' +
        '-11.8, 3.6 -11.1, 3.6 -10.5 Z M 3.6 4.5 C 3.6 5.1, 3.1 5.8, 2.5 6.2 C ' +
        '1.9 6.6, 0.8 6.9, 0 6.9 C -0.8 6.9, -1.9 6.6, -2.5 6.2 C -3.1 5.8, ' +
        '-3.6 5.1, -3.6 4.5 C -3.6 3.9, -3.1 3.2, -2.5 2.8 C -1.9 2.4, -0.8 ' +
        '2.1, -0 2.1 C 0.8 2.1, 1.9 2.4, 2.5 2.8 C 3.1 3.2, 3.6 3.9, 3.6 4.5 Z ' +
        'M 3.6 19.5 C 3.6 20.1, 3.1 20.8, 2.5 21.2 C 1.9 21.6, 0.8 21.9, 0 21.9 ' +
        'C -0.8 21.9, -1.9 21.6, -2.5 21.2 C -3.1 20.8, -3.6 20.1, -3.6 19.5 C ' +
        '-3.6 18.9, -3.1 18.2, -2.5 17.8 C -1.9 17.4, -0.8 17.1, -0 17.1 C 0.8 ' +
        '17.1, 1.9 17.4, 2.5 17.8 C 3.1 18.2, 3.6 18.9, 3.6 19.5 Z M 3.6 33.5 C ' +
        '3.6 34.1, 3.1 34.8, 2.5 35.2 C 1.9 35.6, 0.8 35.9, 0 35.9 C -0.8 35.9, ' +
        '-1.9 35.6, -2.5 35.2 C -3.1 34.8, -3.6 34.1, -3.6 33.5 C -3.6 32.9, ' +
        '-3.1 32.2, -2.5 31.8 C -1.9 31.4, -0.8 31.1, -0 31.1 C 0.8 31.1, 1.9 ' +
        '31.4, 2.5 31.8 C 3.1 32.2, 3.6 32.9, 3.6 33.5 Z'
      ],
      // a crescent blade, heavy at the back, hooked to a point, on a riveted handle
      sickle: [
        'M -44 8 C -43.2 5.6, -36.5 10.2, -35.5 8.4 C -34.5 6.5, -37.7 0.6, ' +
        '-37.9 -3.3 C -38.2 -7.2, -37.8 -11.3, -37 -15.1 C -36.1 -19, -34.7 ' +
        '-22.8, -32.8 -26.3 C -30.9 -29.7, -28.4 -33, -25.6 -35.8 C -22.8 ' +
        '-38.5, -19.5 -41, -16.1 -42.9 C -12.6 -44.8, -8.8 -46.2, -4.9 -47 C ' +
        '-1.1 -47.9, 3 -48.2, 6.9 -47.9 C 10.8 -47.6, 14.9 -46.8, 18.6 -45.4 C ' +
        '22.2 -44, 25.9 -42.1, 29 -39.7 C 32.2 -37.4, 35.1 -34.5, 37.5 -31.4 C ' +
        '39.9 -28.2, 41.8 -24.6, 43.2 -21 C 44.6 -17.3, 45.6 -13.3, 45.9 -9.3 C ' +
        '46.2 -5.4, 45.9 -1.3, 45.1 2.5 C 44.3 6.4, 41.9 11.3, 41.1 13.7 C 40.3 ' +
        '16.1, 40.5 16.8, 40.5 16.8 C 40.5 16.8, 41.1 5.9, 40.9 1.7 C 40.7 ' +
        '-2.6, 40.3 -5.6, 39.4 -8.8 C 38.4 -12.1, 37.1 -15.2, 35.5 -18 C 33.8 ' +
        '-20.7, 31.8 -23.3, 29.6 -25.4 C 27.4 -27.5, 24.8 -29.3, 22.3 -30.6 C ' +
        '19.7 -32, 16.9 -33, 14.2 -33.5 C 11.5 -34.1, 8.6 -34.3, 6 -34.1 C 3.3 ' +
        '-33.9, 0.6 -33.3, -1.7 -32.4 C -4.1 -31.5, -6.4 -30.2, -8.4 -28.7 C ' +
        '-10.3 -27.3, -12.1 -25.5, -13.5 -23.6 C -14.9 -21.7, -16.1 -19.6, ' +
        '-16.9 -17.5 C -17.7 -15.4, -18.1 -13.1, -18.3 -11 C -18.5 -8.8, -18.3 ' +
        '-6.6, -17.9 -4.6 C -17.4 -2.6, -13.7 -0.6, -15.7 1.2 C -17.8 2.9, ' +
        '-28.8 2.9, -30 6 C -31.2 9.1, -33 43.3, -34 47 C -35 50.7, -40.5 50.4, ' +
        '-42 50 C -43.5 49.6, -46.8 47.5, -47 44 C -47.2 40.5, -44.8 10.4, -44 ' +
        '8 Z M -36 38 C -36 38.7, -36.4 39.6, -36.9 40.1 C -37.4 40.6, -38.3 ' +
        '41, -39 41 C -39.7 41, -40.6 40.6, -41.1 40.1 C -41.6 39.6, -42 38.7, ' +
        '-42 38 C -42 37.3, -41.6 36.4, -41.1 35.9 C -40.6 35.4, -39.7 35, -39 ' +
        '35 C -38.3 35, -37.4 35.4, -36.9 35.9 C -36.4 36.4, -36 37.3, -36 38 Z ' +
        'M -35.6 21 C -35.6 21.6, -35.9 22.3, -36.3 22.7 C -36.7 23.1, -37.4 ' +
        '23.4, -38 23.4 C -38.6 23.4, -39.3 23.1, -39.7 22.7 C -40.1 22.3, ' +
        '-40.4 21.6, -40.4 21 C -40.4 20.4, -40.1 19.7, -39.7 19.3 C -39.3 ' +
        '18.9, -38.6 18.6, -38 18.6 C -37.4 18.6, -36.7 18.9, -36.3 19.3 C ' +
        '-35.9 19.7, -35.6 20.4, -35.6 21 Z'
      ],
      // a knapped point: serrated edges, two barbs and a stem
      flint: [
        'M 0 -50 C 0 -50, 6 -44.7, 6 -44.7 C 6 -44.7, 5.5 -40.4, 6.1 -39.3 C ' +
        '6.7 -38.3, 11.9 -34, 11.9 -34 C 11.9 -34, 11 -29.7, 11.5 -28.7 C 12 ' +
        '-27.6, 16.8 -23.3, 16.8 -23.3 C 16.8 -23.3, 15.5 -19.1, 15.9 -18 C ' +
        '16.3 -16.9, 20.7 -12.7, 20.7 -12.7 C 20.7 -12.7, 19 -8.4, 19.3 -7.3 C ' +
        '19.6 -6.3, 23.6 -2, 23.6 -2 C 23.6 -2, 21.4 2.3, 21.6 3.3 C 21.8 4.4, ' +
        '25.4 8.7, 25.4 8.7 C 25.4 8.7, 22.8 12.9, 22.9 14 C 23 15.1, 26.2 ' +
        '19.3, 26.2 19.3 C 26.2 19.3, 23.3 23.6, 23.2 24.7 C 23.1 25.7, 24 ' +
        '28.2, 25 30 C 26 31.8, 35 46, 35 46 C 35 46, 14.9 31, 14 31 C 13.1 31, ' +
        '9.6 46, 9 47 C 8.4 48, 4.6 49.6, 3 50 C 1.4 50.4, -1.4 50.4, -3 50 C ' +
        '-4.6 49.6, -8.4 48, -9 47 C -9.6 46, -13.1 31, -14 31 C -14.9 31, -35 ' +
        '46, -35 46 C -35 46, -26 31.8, -25 30 C -24 28.2, -23.1 25.7, -23.2 ' +
        '24.7 C -23.3 23.6, -26.2 19.3, -26.2 19.3 C -26.2 19.3, -23 15.1, ' +
        '-22.9 14 C -22.8 12.9, -25.4 8.7, -25.4 8.7 C -25.4 8.7, -21.8 4.4, ' +
        '-21.6 3.3 C -21.4 2.3, -23.6 -2, -23.6 -2 C -23.6 -2, -19.6 -6.3, ' +
        '-19.3 -7.3 C -19 -8.4, -20.7 -12.7, -20.7 -12.7 C -20.7 -12.7, -16.3 ' +
        '-16.9, -15.9 -18 C -15.5 -19.1, -16.8 -23.3, -16.8 -23.3 C -16.8 ' +
        '-23.3, -12 -27.6, -11.5 -28.7 C -11 -29.7, -11.9 -34, -11.9 -34 C ' +
        '-11.9 -34, -6.7 -38.3, -6.1 -39.3 C -5.5 -40.4, -6 -44.7, -6 -44.7 C ' +
        '-6 -44.7, 0 -50, 0 -50 Z'
      ],
      // a heavy open ring, twisted (the grooves), with flared terminals
      torc: [
        'M 21 36.4 C 21.9 34.7, 25.9 33.2, 28.1 31.2 C 30.3 29.3, 32.3 27, 34 ' +
        '24.7 C 35.7 22.3, 37.2 19.7, 38.4 17.1 C 39.6 14.4, 40.5 11.6, 41.1 ' +
        '8.7 C 41.7 5.9, 42 2.9, 42 0 C 42 -2.9, 41.7 -5.9, 41.1 -8.7 C 40.5 ' +
        '-11.6, 39.6 -14.4, 38.4 -17.1 C 37.2 -19.7, 35.7 -22.3, 34 -24.7 C ' +
        '32.3 -27, 30.3 -29.3, 28.1 -31.2 C 25.9 -33.2, 23.5 -34.9, 21 -36.4 C ' +
        '18.5 -37.8, 15.7 -39, 13 -39.9 C 10.2 -40.8, 7.3 -41.5, 4.4 -41.8 C ' +
        '1.5 -42.1, -1.5 -42.1, -4.4 -41.8 C -7.3 -41.5, -10.2 -40.8, -13 -39.9 ' +
        'C -15.7 -39, -18.5 -37.8, -21 -36.4 C -23.5 -34.9, -25.9 -33.2, -28.1 ' +
        '-31.2 C -30.3 -29.3, -32.3 -27, -34 -24.7 C -35.7 -22.3, -37.2 -19.7, ' +
        '-38.4 -17.1 C -39.6 -14.4, -40.5 -11.6, -41.1 -8.7 C -41.7 -5.9, -42 ' +
        '-2.9, -42 -0 C -42 2.9, -41.7 5.9, -41.1 8.7 C -40.5 11.6, -39.6 14.4, ' +
        '-38.4 17.1 C -37.2 19.7, -35.7 22.3, -34 24.7 C -32.3 27, -30.3 29.3, ' +
        '-28.1 31.2 C -25.9 33.2, -21.9 34.7, -21 36.4 C -20.1 38.1, -23.3 ' +
        '40.3, -22.8 41.5 C -22.2 42.8, -19.4 43.4, -17.6 43.8 C -15.8 44.1, ' +
        '-13.8 44.1, -12 43.6 C -10.2 43.2, -8.4 42.3, -6.9 41.1 C -5.5 40, ' +
        '-4.2 38.4, -3.4 36.7 C -2.6 35.1, -2.2 33.1, -2.1 31.2 C -2.1 29.4, ' +
        '-2.5 27.4, -3.2 25.7 C -4 24, -5.2 22.4, -6.6 21.2 C -8 20, -10.4 ' +
        '18.1, -11.5 18.5 C -12.7 18.9, -12.3 23.2, -13.5 23.4 C -14.7 23.5, ' +
        '-17.2 20.9, -18.8 19.4 C -20.3 17.9, -21.7 16.2, -22.9 14.3 C -24.1 ' +
        '12.5, -25 10.4, -25.7 8.3 C -26.4 6.3, -26.8 4.1, -26.9 1.9 C -27.1 ' +
        '-0.3, -27 -2.5, -26.6 -4.7 C -26.2 -6.8, -25.6 -9, -24.7 -11 C -23.8 ' +
        '-13, -22.6 -14.9, -21.3 -16.6 C -19.9 -18.3, -18.3 -19.9, -16.6 -21.3 ' +
        'C -14.9 -22.6, -13 -23.8, -11 -24.7 C -9 -25.6, -6.8 -26.2, -4.7 -26.6 ' +
        'C -2.5 -27, -0.3 -27.1, 1.9 -26.9 C 4.1 -26.8, 6.3 -26.4, 8.3 -25.7 C ' +
        '10.4 -25, 12.5 -24.1, 14.3 -22.9 C 16.2 -21.7, 17.9 -20.3, 19.4 -18.8 ' +
        'C 20.9 -17.2, 22.3 -15.4, 23.4 -13.5 C 24.5 -11.6, 25.4 -9.5, 26 -7.4 ' +
        'C 26.6 -5.3, 26.9 -3.1, 27 -0.9 C 27.1 1.2, 26.9 3.5, 26.4 5.6 C 26 ' +
        '7.7, 25.2 9.9, 24.3 11.8 C 23.3 13.8, 22.1 15.7, 20.7 17.4 C 19.3 19, ' +
        '17.4 21.7, 15.9 21.8 C 14.3 22, 13.1 18.6, 11.5 18.5 C 10 18.4, 8 20, ' +
        '6.6 21.2 C 5.2 22.4, 4 24, 3.2 25.7 C 2.5 27.4, 2.1 29.4, 2.1 31.2 C ' +
        '2.2 33.1, 2.6 35.1, 3.4 36.7 C 4.2 38.4, 5.5 40, 6.9 41.1 C 8.4 42.3, ' +
        '10.2 43.2, 12 43.6 C 13.8 44.1, 15.8 44.1, 17.6 43.8 C 19.4 43.4, 22.2 ' +
        '42.8, 22.8 41.5 C 23.3 40.3, 20.1 38.1, 21 36.4 Z M 20.6 24.3 C 20.5 ' +
        '23.9, 21 23.3, 21.8 22.9 C 22.6 22.4, 24.1 21.9, 25.3 21.6 C 26.5 ' +
        '21.3, 28.1 21.2, 29 21.2 C 29.9 21.3, 30.6 21.6, 30.7 21.9 C 30.8 ' +
        '22.3, 30.2 22.9, 29.5 23.3 C 28.7 23.7, 27.2 24.3, 26 24.5 C 24.8 ' +
        '24.8, 23.2 25, 22.3 24.9 C 21.4 24.9, 20.7 24.6, 20.6 24.3 Z M 26.8 ' +
        '17.2 C 26.6 16.9, 26.9 16.2, 27.6 15.5 C 28.2 14.9, 29.5 13.9, 30.5 ' +
        '13.3 C 31.6 12.7, 33 12, 33.9 11.8 C 34.8 11.6, 35.6 11.7, 35.8 12 C ' +
        '35.9 12.3, 35.6 13, 35 13.7 C 34.4 14.3, 33.1 15.3, 32 15.9 C 31 16.5, ' +
        '29.5 17.1, 28.6 17.3 C 27.7 17.6, 26.9 17.5, 26.8 17.2 Z M 30.6 8.6 C ' +
        '30.4 8.4, 30.5 7.6, 30.9 6.8 C 31.3 6, 32.2 4.7, 33.1 3.8 C 33.9 2.9, ' +
        '35.1 1.9, 35.9 1.4 C 36.7 0.9, 37.5 0.8, 37.7 1 C 38 1.2, 37.9 2, 37.4 ' +
        '2.8 C 37 3.6, 36.1 4.9, 35.3 5.8 C 34.4 6.7, 33.2 7.8, 32.4 8.2 C 31.7 ' +
        '8.7, 30.9 8.8, 30.6 8.6 Z M 31.8 -0.7 C 31.5 -0.9, 31.4 -1.7, 31.5 ' +
        '-2.6 C 31.7 -3.4, 32.2 -5, 32.7 -6.1 C 33.3 -7.2, 34.1 -8.5, 34.7 -9.2 ' +
        'C 35.3 -9.8, 36 -10.2, 36.4 -10.1 C 36.7 -9.9, 36.8 -9.1, 36.6 -8.2 C ' +
        '36.5 -7.3, 36 -5.8, 35.4 -4.7 C 34.9 -3.6, 34 -2.3, 33.4 -1.6 C 32.8 ' +
        '-1, 32.1 -0.6, 31.8 -0.7 Z M 30.2 -10 C 29.8 -10, 29.5 -10.8, 29.4 ' +
        '-11.7 C 29.3 -12.6, 29.3 -14.1, 29.5 -15.4 C 29.7 -16.6, 30.2 -18.1, ' +
        '30.5 -18.9 C 30.9 -19.7, 31.5 -20.3, 31.8 -20.3 C 32.2 -20.2, 32.5 ' +
        '-19.5, 32.6 -18.6 C 32.7 -17.7, 32.7 -16.1, 32.5 -14.9 C 32.3 -13.7, ' +
        '31.9 -12.1, 31.5 -11.3 C 31.1 -10.5, 30.5 -9.9, 30.2 -10 Z M 26 -18.4 ' +
        'C 25.6 -18.3, 25.1 -18.9, 24.7 -19.7 C 24.3 -20.6, 23.9 -22.1, 23.7 ' +
        '-23.3 C 23.6 -24.5, 23.5 -26.1, 23.7 -27 C 23.8 -27.9, 24.2 -28.6, ' +
        '24.5 -28.7 C 24.9 -28.7, 25.4 -28.1, 25.8 -27.3 C 26.1 -26.5, 26.5 ' +
        '-25, 26.7 -23.7 C 26.9 -22.5, 26.9 -20.9, 26.8 -20 C 26.7 -19.1, 26.3 ' +
        '-18.4, 26 -18.4 Z M 19.4 -25.2 C 19.1 -25, 18.4 -25.4, 17.8 -26.1 C ' +
        '17.2 -26.8, 16.4 -28.1, 15.9 -29.2 C 15.4 -30.4, 14.9 -31.9, 14.7 ' +
        '-32.8 C 14.6 -33.7, 14.7 -34.4, 15.1 -34.6 C 15.4 -34.7, 16.1 -34.3, ' +
        '16.7 -33.7 C 17.3 -33, 18.1 -31.6, 18.6 -30.5 C 19.1 -29.4, 19.6 ' +
        '-27.9, 19.8 -27 C 19.9 -26.1, 19.8 -25.3, 19.4 -25.2 Z M 11.2 -29.8 C ' +
        '11 -29.5, 10.2 -29.7, 9.4 -30.2 C 8.7 -30.7, 7.5 -31.7, 6.6 -32.6 C ' +
        '5.8 -33.5, 4.9 -34.8, 4.5 -35.6 C 4.1 -36.4, 4 -37.2, 4.3 -37.5 C 4.5 ' +
        '-37.7, 5.3 -37.5, 6.1 -37.1 C 6.9 -36.6, 8.1 -35.5, 8.9 -34.6 C 9.7 ' +
        '-33.7, 10.6 -32.4, 11 -31.6 C 11.4 -30.8, 11.5 -30, 11.2 -29.8 Z M 2.1 ' +
        '-31.7 C 1.9 -31.4, 1.1 -31.4, 0.2 -31.6 C -0.7 -31.8, -2.1 -32.5, -3.2 ' +
        '-33.1 C -4.2 -33.8, -5.5 -34.7, -6.1 -35.4 C -6.7 -36.1, -7 -36.8, ' +
        '-6.9 -37.1 C -6.7 -37.4, -5.9 -37.5, -5 -37.2 C -4.1 -37, -2.7 -36.3, ' +
        '-1.6 -35.7 C -0.6 -35.1, 0.7 -34.1, 1.3 -33.4 C 1.9 -32.8, 2.2 -32, ' +
        '2.1 -31.7 Z M -7.3 -31 C -7.4 -30.6, -8.2 -30.3, -9.1 -30.3 C -10 ' +
        '-30.3, -11.5 -30.5, -12.7 -30.8 C -13.9 -31, -15.4 -31.6, -16.2 -32.1 ' +
        'C -17 -32.5, -17.5 -33.1, -17.4 -33.5 C -17.3 -33.8, -16.6 -34.1, ' +
        '-15.7 -34.1 C -14.8 -34.2, -13.2 -34, -12 -33.7 C -10.8 -33.4, -9.3 ' +
        '-32.8, -8.5 -32.3 C -7.8 -31.9, -7.2 -31.3, -7.3 -31 Z M -16 -27.5 C ' +
        '-16 -27.1, -16.7 -26.6, -17.5 -26.3 C -18.4 -26, -19.9 -25.8, -21.2 ' +
        '-25.7 C -22.4 -25.6, -24 -25.7, -24.9 -25.9 C -25.7 -26.1, -26.4 ' +
        '-26.6, -26.4 -26.9 C -26.5 -27.3, -25.8 -27.8, -25 -28.1 C -24.1 ' +
        '-28.3, -22.5 -28.6, -21.3 -28.7 C -20.1 -28.7, -18.5 -28.6, -17.6 ' +
        '-28.4 C -16.7 -28.2, -16.1 -27.8, -16 -27.5 Z M -23.4 -21.6 C -23.3 ' +
        '-21.2, -23.7 -20.6, -24.4 -20 C -25.2 -19.5, -26.6 -18.8, -27.7 -18.4 ' +
        'C -28.9 -18, -30.5 -17.6, -31.4 -17.5 C -32.3 -17.5, -33 -17.7, -33.1 ' +
        '-18 C -33.3 -18.3, -32.8 -19, -32.1 -19.5 C -31.3 -20.1, -29.9 -20.8, ' +
        '-28.8 -21.2 C -27.6 -21.6, -26.1 -22, -25.2 -22 C -24.3 -22.1, -23.5 ' +
        '-21.9, -23.4 -21.6 Z M -28.7 -13.8 C -28.4 -13.5, -28.7 -12.7, -29.2 ' +
        '-12 C -29.8 -11.3, -30.9 -10.2, -31.9 -9.5 C -32.9 -8.7, -34.3 -7.9, ' +
        '-35.1 -7.6 C -36 -7.3, -36.8 -7.2, -37 -7.5 C -37.2 -7.8, -36.9 -8.6, ' +
        '-36.4 -9.3 C -35.8 -10, -34.7 -11.1, -33.7 -11.9 C -32.7 -12.6, -31.4 ' +
        '-13.4, -30.5 -13.7 C -29.7 -14, -28.9 -14.1, -28.7 -13.8 Z M -31.4 ' +
        '-4.8 C -31.2 -4.6, -31.2 -3.8, -31.5 -3 C -31.8 -2.1, -32.6 -0.7, ' +
        '-33.3 0.3 C -34 1.3, -35.1 2.4, -35.8 3 C -36.5 3.6, -37.3 3.8, -37.6 ' +
        '3.6 C -37.8 3.4, -37.8 2.6, -37.5 1.7 C -37.2 0.9, -36.4 -0.5, -35.7 ' +
        '-1.5 C -35 -2.5, -33.9 -3.6, -33.2 -4.2 C -32.5 -4.8, -31.7 -5, -31.4 ' +
        '-4.8 Z M -31.5 4.6 C -31.1 4.7, -30.9 5.5, -31 6.4 C -31 7.3, -31.3 ' +
        '8.8, -31.7 10 C -32.1 11.2, -32.8 12.6, -33.4 13.3 C -33.9 14.1, -34.5 ' +
        '14.5, -34.9 14.4 C -35.2 14.3, -35.4 13.5, -35.4 12.6 C -35.3 11.7, ' +
        '-35 10.2, -34.6 9 C -34.2 7.9, -33.5 6.4, -33 5.7 C -32.5 4.9, -31.8 ' +
        '4.5, -31.5 4.6 Z M -28.8 13.6 C -28.4 13.6, -28 14.3, -27.7 15.2 C ' +
        '-27.5 16, -27.4 17.6, -27.4 18.8 C -27.5 20.1, -27.7 21.6, -28 22.5 C ' +
        '-28.3 23.4, -28.8 24, -29.1 24 C -29.5 24, -29.9 23.3, -30.1 22.4 C ' +
        '-30.3 21.6, -30.5 20, -30.4 18.7 C -30.4 17.5, -30.1 15.9, -29.9 15.1 ' +
        'C -29.6 14.2, -29.1 13.6, -28.8 13.6 Z'
      ]
    };

    // Which slot carries which symbol. Eight across ten slots, so two repeat —
    // at a different size and turn, so a repeat never reads as the same mark.
    // Five clusters over ten slots, so each comes round twice — at a
    // different size and turn, which is what keeps a repeat from reading as
    // the same object twice.
    // THE SYMBOLS ARE HER OWN DRAWINGS NOW: motifs cut out of her two tattoo
    // flash sheets (esset/hero/, cut by scratch tool cutmotifs.swift — lines
    // kept in the forms' blue, paper made transparent). Each slot carries one
    // drawing, whole and at its own proportions, inside the same 100-unit box
    // the drawn glyphs used, so every composition moves them exactly as before.
    // The GLYPHS above stay defined, unused, for a quick way back.
    // Solid drawings only: the outline motifs (tower, pin-figure, bird,
    // fountain, crouch, pair, legs, phoenix — still in esset/hero/) were
    // swapped for the filled ones from her yellow sheet and the beast
    // sheet; the dancers and the dog-figure were already solid and stay.
    // No repeats: ten slots, ten different drawings. The cloud and the
    // crouching figure are white-FILLED on her yellow sheet, so they are cut
    // the other way round (fillcut.swift): the fill is the solid mass and her
    // black line work runs through it as cuts. printfigure is esset/m_c9ffa149f4.png.
    const FORMS = [
      { kind: 'blob',     img: 'esset/hero/dancers.png',   r: 43 },
      { kind: 'bar',      img: 'esset/hero/beast.png',     r: 39 },
      { kind: 'hook',     img: 'esset/hero/moon.png',      r: 40 },
      { kind: 'teardrop', img: 'esset/hero/wave.png',      r: 38 },
      { kind: 'slab',     img: 'esset/hero/dogfigure.png', r: 36 },
      { kind: 'crescent', img: 'esset/hero/ornament.png',  r: 36 },
      { kind: 'kidney',   img: 'esset/hero/frame.png',     r: 36 },
      { kind: 'arch',     img: 'esset/hero/cloud.png',     r: 32 },
      { kind: 'pill',     img: 'esset/hero/printfigure.png', r: 30 },
      { kind: 'dot',      img: 'esset/hero/crouchsolid.png', r: 30 }
    ];
    FORMS.forEach(f => { f.rx = f.r; f.ry = f.r; });




    // A composition is only a list of stations: x, y, turn, and a scale on the
    // form's own size.
    const COMPOSITIONS = [
      {
        name: 'strewn',
        places: [
          { x:  46, y:  46, a:  0.20, s: 1.00 },
          { x: 208, y:  22, a: -0.12, s: 0.95 },
          { x: 322, y:  52, a:  1.90, s: 0.85 },
          { x: 246, y: 104, a:  0.16, s: 1.00 },
          { x:  30, y: 128, a:  2.60, s: 0.78 },
          { x: 318, y: 150, a: -0.35, s: 0.92 },
          { x:  96, y: 172, a:  0.70, s: 0.88 },
          { x: 300, y:  20, a:  0.22, s: 0.90 },
          { x: 366, y: 106, a:  0.10, s: 0.95 },
          { x: 176, y:  60, a:  0.00, s: 1.10 }
        ]
      },
      {
        name: 'rows',
        places: [
          { x:  44, y:  34, a:  0.06, s: 0.90 },
          { x: 180, y:  30, a:  0.00, s: 1.02 },
          { x: 290, y:  36, a:  0.40, s: 0.82 },
          { x:  48, y: 104, a: -0.06, s: 0.96 },
          { x: 146, y: 102, a:  1.20, s: 0.84 },
          { x: 330, y: 106, a:  0.10, s: 0.94 },
          { x:  38, y: 172, a:  0.30, s: 0.86 },
          { x: 224, y: 170, a:  0.04, s: 1.06 },
          { x: 312, y: 168, a: -0.10, s: 0.92 },
          { x: 112, y:  98, a:  0.00, s: 1.30 }
        ]
      },
      {
        name: 'cluster',
        places: [
          { x: 150, y:  76, a:  0.18, s: 0.86 },
          { x: 250, y: 176, a:  0.55, s: 0.72 },
          { x: 238, y:  44, a:  2.40, s: 0.70 },
          { x:  44, y:  46, a:  0.30, s: 0.62 },
          { x: 214, y: 124, a:  3.60, s: 0.74 },
          { x: 158, y:  24, a:  0.10, s: 0.62 },
          { x:  54, y: 176, a:  0.90, s: 0.60 },
          { x: 352, y: 176, a:  0.30, s: 0.58 },
          { x: 286, y:  20, a: -0.20, s: 0.58 },
          { x: 190, y:  96, a:  0.00, s: 1.30 }
        ]
      },
      {
        name: 'current',
        places: [
          { x:  54, y: 160, a:  0.52, s: 1.05 },
          { x: 158, y: 116, a:  0.50, s: 1.00 },
          { x: 250, y:  78, a:  1.10, s: 0.86 },
          { x: 206, y:  98, a:  0.48, s: 0.90 },
          { x: 318, y:  46, a:  2.20, s: 0.82 },
          { x:  84, y:  58, a: -0.40, s: 1.00 },
          { x: 186, y:  30, a:  0.00, s: 0.84 },
          { x: 120, y:  24, a: -0.34, s: 0.90 },
          { x: 352, y: 130, a:  0.30, s: 0.92 },
          { x: 348, y: 186, a:  0.00, s: 0.90 }
        ]
      }
    ];

    // Two hoops per arrangement, travelling with the field.
    const COMP_RINGS = [
      [ { cx: 120, cy:  60, rx:  96, ry: 54 }, { cx: 268, cy: 146, rx:  84, ry: 46 } ],
      [ { cx: 190, cy:  65, rx: 150, ry: 30 }, { cx: 190, cy: 135, rx: 150, ry: 30 } ],
      [ { cx: 178, cy:  98, rx: 132, ry: 88 }, { cx: 178, cy:  98, rx:  74, ry: 62 } ],
      [ { cx: 120, cy: 150, rx: 118, ry: 52 }, { cx: 256, cy:  62, rx: 112, ry: 48 } ]
    ];

    // One topology for the cords, shared by every composition. The strings are
    // the constant thing in this piece — they are what hauls the forms from
    // one arrangement into the next — so they must never be re-tied.
    //
    // Twenty cords criss-crossing at random read as clutter. This is one
    // continuous string threading every form in turn, plus two ties across it
    // so the field has something to pull against. Fewer lines, and the eye
    // can follow them.
    // Ordered as a walk across the STREWN layout rather than by slot number,
    // so the string snakes through the field instead of doubling back over
    // itself thirteen times.
    const THREAD_LINKS = [
      // Rewritten for ten bodies. A single walk across the strewn layout so
      // every body is on the chain, plus two cross-ties so the field reads as
      // a web and not a washing line.
      [0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],
      [0,5],[2,7]
    ];

    function pickComposition() {
      const q = new URLSearchParams(location.search).get('comp');
      const n = parseInt(q, 10);
      if (n >= 1 && n <= COMPOSITIONS.length) return n - 1;
      return 0;
    }

    // The field is always travelling FROM one composition TO another. At rest
    // compU sits at 1 and `fromPlaces` already equals the target, so nothing
    // moves. `fromPlaces` is a snapshot, never a reference into COMPOSITIONS:
    // a jump taken mid-travel has to start from what is actually on screen,
    // and the pristine arrangements must survive to be travelled to again.
    let compFrom = pickComposition();
    let compTo = compFrom;
    let compU = 1;
    let compLocked = new URLSearchParams(location.search).has('comp');

    function snapshotPlaces(src) {
      return src.map(s => ({
        x: s.x, y: s.y, a: s.a, s: s.s, rx: s.rx, ry: s.ry,
        kind: s.kind, tame: s.kind ? 1 : 0
      }));
    }

    // UPRIGHT SCREENS (phones held upright): the arrangements are laid out on
    // a wide 380×200 canvas. Filled into a tall screen that canvas is sliced to
    // a thin middle strip and half the forms stand off-screen. On an upright
    // screen every arrangement is turned on its side instead — each form's
    // across and down positions swap, and so do the hoops' — on a 200×380
    // canvas. The forms themselves stay upright and unchanged; the cords are
    // strung from the forms, so they follow. Rotating the phone re-lays it.
    let fieldUpright = false;
    function layFieldForScreen() {
      const upright = window.innerWidth / window.innerHeight < 0.8;
      if (upright === fieldUpright) return;
      fieldUpright = upright;
      COMPOSITIONS.forEach(c => c.places.forEach(p => { const x = p.x; p.x = p.y; p.y = x; }));
      COMP_RINGS.forEach(pair => pair.forEach(r => {
        const cx = r.cx, rx = r.rx; r.cx = r.cy; r.cy = cx; r.rx = r.ry; r.ry = rx;
      }));
      if (svg) {
        svg.setAttribute('viewBox', upright ? '0 0 200 380' : '0 0 380 200');
        // upright: the whole canvas is fitted in (screens from a narrow phone to
        // a tablet differ in shape, and trimming cut forms off at the top and
        // bottom); wide: it fills the screen as it always has
        svg.setAttribute('preserveAspectRatio', upright ? 'xMidYMid meet' : 'xMidYMid slice');
      }
    }
    layFieldForScreen();

    let fromPlaces = snapshotPlaces(COMPOSITIONS[compFrom].places);
    let fromRings = COMP_RINGS[compFrom].map(r => Object.assign({}, r));
    window.addEventListener('resize', () => {
      const was = fieldUpright;
      layFieldForScreen();
      if (was !== fieldUpright) {
        // start the current haul again from the re-laid arrangement
        fromPlaces = snapshotPlaces(COMPOSITIONS[compFrom].places);
        fromRings = COMP_RINGS[compFrom].map(r => Object.assign({}, r));
      }
    });

    // Live state per form: where it currently stands, plus the offset the
    // cords have dragged it to. Rendering reads ONLY from here.
    const liveShapes = FORMS.map((f, i) => {
      const p = COMPOSITIONS[compFrom].places[i];
      return {
        form: f,
        cx: p.x, cy: p.y, spin: p.a,
        rx: (p.rx !== undefined ? p.rx : f.rx * p.s) * FIELD_SCALE,
        ry: (p.ry !== undefined ? p.ry : f.ry * p.s) * FIELD_SCALE,
        kindA: p.kind || f.kind, kindB: p.kind || f.kind, ku: 1,
        tame: p.kind ? 1 : 0,
        seed: i * 2.399963, ox: 0, oy: 0, vx: 0, vy: 0
      };
    });

    // Slow away, quick through the middle, slow into place. Smootherstep, not
    // the cubic: its acceleration is zero at both ends as well as its speed,
    // so the forms neither jerk into motion nor arrive still moving.
    // ------------------------------------------------------------------------
    // THE CORDS IN THE WORKS INDEX
    // A thin line strung from one work's number to the next along each row,
    // hanging under its own weight and pulling straight when the field above
    // hauls. It is NOT on a clock of its own: it reads `cordPull`, the exact
    // same number the hero's cords are driven by, written once per frame in
    // the loop below. Give it its own timer and the two go out of phase
    // within a few seconds, which is precisely what was asked not to happen.
    // ------------------------------------------------------------------------
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const WORKS_CORD_SAG = 26;     // px of droop at full slack, over a full span
    let cordPull = 0;              // 0 = hanging slack, 1 = hauled straight
    const worksCords = { svg: null, paths: [], spans: [] };

    function rebuildWorksCords() {
      const grid = document.getElementById('projects-grid');
      if (!grid) return;
      let svg = grid.querySelector('.works-cords');
      if (!svg) {
        svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'works-cords');
        svg.setAttribute('aria-hidden', 'true');
        grid.insertBefore(svg, grid.firstChild);
      }
      const gridRect = grid.getBoundingClientRect();
      if (!gridRect.width || !gridRect.height) return;
      svg.setAttribute('viewBox',
        '0 0 ' + Math.round(gridRect.width) + ' ' + Math.round(gridRect.height));

      // Numbers are grouped into rows by where they actually sit, not by
      // index: the grid reflows to one, two or four columns, and a fixed
      // stride would string cords diagonally across the page at narrow widths.
      const rows = [];
      Array.from(grid.querySelectorAll('.works-num-ink')).forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const y = r.top - gridRect.top + r.height / 2;
        let row = null;
        for (let i = 0; i < rows.length; i++) {
          if (Math.abs(rows[i].y - y) < 28) { row = rows[i]; break; }
        }
        if (!row) { row = { y: y, items: [] }; rows.push(row); }
        row.items.push({ x: r.left - gridRect.left + r.width / 2, y: y });
      });

      const spans = [];
      // On a phone a row holds only two works, so a cord from one number to
      // the next stopped in mid-screen. There each row is one continuous
      // string instead, edge to edge: in from the left edge of the screen,
      // pinned at each number in turn, and on out to the right edge — the
      // spans chained, each hanging on its own (the same sag and the same
      // take-up as the cords on a wide screen).
      const edgeToEdge = window.innerWidth <= 768;
      const screenLeft = -gridRect.left;
      const screenRight = window.innerWidth - gridRect.left;
      rows.forEach(row => {
        row.items.sort((a, b) => a.x - b.x);
        const pts = edgeToEdge
          ? [{ x: screenLeft, y: row.y }].concat(row.items, [{ x: screenRight, y: row.y }])
          : row.items;
        for (let i = 0; i < pts.length - 1; i++) {
          spans.push([pts[i], pts[i + 1]]);
        }
      });

      while (svg.childNodes.length > spans.length) svg.removeChild(svg.lastChild);
      while (svg.childNodes.length < spans.length) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', 'works-cord');
        svg.appendChild(path);
      }
      worksCords.svg = svg;
      worksCords.spans = spans;
      worksCords.paths = Array.prototype.slice.call(svg.childNodes);
      drawWorksCords();
    }

    function drawWorksCords() {
      if (!worksCords.spans.length) return;
      const slack = 1 - cordPull;
      for (let i = 0; i < worksCords.spans.length; i++) {
        const a = worksCords.spans[i][0], b = worksCords.spans[i][1];
        const dx = b.x - a.x;
        // A short span hangs less than a long one, the way a real rope does.
        const sag = WORKS_CORD_SAG * slack * Math.min(1, Math.abs(dx) / 240);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        // One quadratic: its apex sits at half the control offset, so the
        // control point goes down by twice the sag we want to see.
        worksCords.paths[i].setAttribute('d',
          'M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
          ' Q ' + mx.toFixed(1) + ' ' + (my + sag * 2).toFixed(1) +
          ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1));
      }
    }

    let worksCordResizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(worksCordResizeTimer);
      worksCordResizeTimer = setTimeout(rebuildWorksCords, 120);
    });
    window.addEventListener('mihal:portfolio-rendered', rebuildWorksCords);
    // The grid may already have been laid out before this module ran, in
    // which case that event has been and gone. Build once on our own account,
    // and again whenever the works stage comes up — the grid can only be
    // measured properly once it is actually on screen.
    requestAnimationFrame(rebuildWorksCords);
    window.addEventListener('mihal:stage-works', rebuildWorksCords);

    function travelEase(t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t * t * t * (t * (t * 6 - 15) + 10);
    }

    // A place normally just moves the form and scales it. It MAY also override
    // the form's proportions (rx/ry) and its silhouette (kind) — which one
    // arrangement needs, because a rank of identical arches cannot be built
    // out of fourteen deliberately different shapes. Everything else about a
    // form — its warp, shear and bend — stays its own, so it is still
    // recognisably the same thing standing in a new pose.
    function placeRx(p, f) { return p.rx !== undefined ? p.rx : f.rx * p.s; }
    function placeRy(p, f) { return p.ry !== undefined ? p.ry : f.ry * p.s; }
    function placeKind(p, f) { return p.kind || f.kind; }

    function updateLiveShapes() {
      const B = COMPOSITIONS[compTo].places;
      // Every form is on the same clock. Staggering their departures looked
      // like a wind-up — some setting off while others hung back — which is
      // exactly the hesitation this field should not have.
      const u = travelEase(compU);
      for (let i = 0; i < SLOT_COUNT; i++) {
        const a = fromPlaces[i], b = B[i], s = liveShapes[i], f = s.form;
        s.cx = a.x + (b.x - a.x) * u;
        s.cy = a.y + (b.y - a.y) * u;
        // A shade smaller across the board: at full size the forms crowded
        // each other and the blue stopped reading as ground.
        const arx = a.rx !== undefined ? a.rx : placeRx(a, f);
        const ary = a.ry !== undefined ? a.ry : placeRy(a, f);
        s.rx = (arx + (placeRx(b, f) - arx) * u) * FIELD_SCALE;
        s.ry = (ary + (placeRy(b, f) - ary) * u) * FIELD_SCALE;
        // turn the short way round
        let ds = b.a - a.a;
        while (ds > Math.PI) ds -= Math.PI * 2;
        while (ds < -Math.PI) ds += Math.PI * 2;
        s.spin = a.a + ds * u;
        // One silhouette genuinely unfolds into the other rather than popping
        // at the halfway mark: the two families' radius profiles are blended.
        s.kindA = a.kind || f.kind;
        s.kindB = placeKind(b, f);
        s.ku = u;
        // An arrangement that DICTATES the silhouette dictates it fully. The
        // per-form warp, shear and bend are what make fourteen shapes read as
        // fourteen different things — but applied to a rank of arches meant
        // to line up, they turn every one of them into a different leaning
        // lump. Damped to a sixth, so the rank still has a hand to it.
        const ta = a.tame !== undefined ? a.tame : (a.kind ? 1 : 0);
        const tb = b.tame !== undefined ? b.tame : (b.kind ? 1 : 0);
        s.tame = ta + (tb - ta) * u;
      }
    }

    // The hoops travel with the field.
    function liveRings() {
      const B = COMP_RINGS[compTo];
      const u = travelEase(compU);
      return [0, 1].map(i => ({
        cx: fromRings[i].cx + (B[i].cx - fromRings[i].cx) * u,
        cy: fromRings[i].cy + (B[i].cy - fromRings[i].cy) * u,
        rx: fromRings[i].rx + (B[i].rx - fromRings[i].rx) * u,
        ry: fromRings[i].ry + (B[i].ry - fromRings[i].ry) * u
      }));
    }

    const pebblesGroup = document.getElementById('morph-pebbles-group');
    const pebbleBloomGroup = document.getElementById('morph-pebbles-bloom');
    const pebbleRimGroup = document.getElementById('morph-pebbles-rim');
    const pebbleBevelGroup = document.getElementById('morph-pebbles-bevel');
    const pebbleMarksGroup = document.getElementById('morph-pebble-marks');
    const compRingsGroup = document.getElementById('morph-comp-rings-group');
    let pebbleEls = [];
    let pebbleBloomEls = [];
    let pebbleRimEls = [];
    let pebbleBevelEls = [];
    let compRingEls = [];

    let pebbleMarkEls = [];

    function buildComposition() {
      pebbleEls = [];
      pebbleBloomEls = [];
      pebbleRimEls = [];
      pebbleBevelEls = [];
      pebbleMarkEls = [];
      compRingEls = [];

      // The glow and bevel layers are the same fourteen paths over again, so
      // they are built the same way and fed the same `d` every frame. One
      // path built once, drawn four times.
      const layer = (group, cls, into) => {
        if (!group) return;
        group.innerHTML = '';
        for (let i = 0; i < SLOT_COUNT; i++) {
          const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          el.setAttribute('class', cls);
          group.appendChild(el);
          into.push(el);
        }
      };
      layer(pebbleBloomGroup, 'morph-pebble-bloom', pebbleBloomEls);
      layer(pebbleRimGroup, 'morph-pebble-rim', pebbleRimEls);
      layer(pebbleBevelGroup, 'morph-pebble-bevel', pebbleBevelEls);
      if (pebbleMarksGroup) {
        pebbleMarksGroup.innerHTML = '';
        for (let i = 0; i < SLOT_COUNT; i++) {
          const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          el.setAttribute('class', 'morph-pebble-mark');
          pebbleMarksGroup.appendChild(el);
          pebbleMarkEls.push(el);
        }
      }
      if (pebblesGroup) {
        pebblesGroup.innerHTML = '';
        for (let i = 0; i < SLOT_COUNT; i++) {
          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          g.setAttribute('class', 'morph-pebble');
          if (FORMS[i].img) {
            const im = document.createElementNS('http://www.w3.org/2000/svg', 'image');
            im.setAttribute('href', FORMS[i].img);
            im.setAttribute('x', '-50');
            im.setAttribute('y', '-50');
            im.setAttribute('width', '100');
            im.setAttribute('height', '100');
            im.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            g.appendChild(im);
            pebblesGroup.appendChild(g);
            pebbleEls.push(g);
            continue;
          }
          const parts = GLYPHS[FORMS[i].glyph] || GLYPHS.star;
          for (let k = 0; k < parts.length; k++) {
            const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            el.setAttribute('d', parts[k]);
            el.setAttribute('fill', BLOB_FILL);
            el.setAttribute('fill-rule', 'evenodd');   // the counters cut through
            el.setAttribute('stroke', 'none');
            g.appendChild(el);
          }
          pebblesGroup.appendChild(g);
          pebbleEls.push(g);
        }
      }
      if (compRingsGroup) {
        compRingsGroup.innerHTML = '';
        for (let i = 0; i < 2; i++) {
          const el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
          el.setAttribute('class', 'morph-comp-ring');
          compRingsGroup.appendChild(el);
          compRingEls.push(el);
        }
      }
    }
    buildComposition();
    updateLiveShapes();
    document.body.dataset.comp = COMPOSITIONS[compTo].name;

    function travelToComposition(i, announce) {
      const next = ((i % COMPOSITIONS.length) + COMPOSITIONS.length) % COMPOSITIONS.length;
      if (next === compTo && compU < 1) return;
      // start from what is on screen right now, so a jump taken mid-travel
      // doesn't snap back
      // FIELD_SCALE has to come back out here: updateLiveShapes puts it back
      // in, and a snapshot that carried it would shrink the field a little
      // more on every single travel.
      // `tame` is carried EXPLICITLY. It used to be re-derived from whether
      // the place named a silhouette — but this snapshot always names one, so
      // after the very first travel every arrangement counted as tamed, and
      // then travelling into one that isn't swung the warp and shear back on.
      // That was the shape quietly changing as the field settled.
      fromPlaces = liveShapes.map((s) => ({
        x: s.cx, y: s.cy, a: s.spin,
        s: s.rx / (s.form.rx * FIELD_SCALE),
        rx: s.rx / FIELD_SCALE, ry: s.ry / FIELD_SCALE,
        kind: s.ku >= 0.5 ? s.kindB : s.kindA,
        tame: s.tame
      }));
      fromRings = liveRings();
      compFrom = compTo;
      compTo = next;
      compU = 0;
      compArrivedAt = -1;
      document.body.dataset.comp = COMPOSITIONS[compTo].name;
      if (announce) showToast('קומפוזיציה ' + (compTo + 1) + ' — ' + COMPOSITIONS[compTo].name);
    }

    // Jumping by hand parks the field on that arrangement until the next key.
    function setComposition(i) {
      compLocked = true;
      travelToComposition(i, true);
    }
    window.addEventListener('keydown', (e) => {
      // A year typed into a description is not four composition shortcuts.
      if (isTypingTarget(e)) return;
      if (['1', '2', '3', '4'].includes(e.key)) setComposition(+e.key - 1);
    });

    // ------------------------------------------------------------------
    // THE CORDS MOVE THE FORMS
    // The strings are not decoration drawn between fixed blobs: they are under
    // tension, and the forms hang off them. When a cord hauls in, whatever it
    // is tied to is dragged along its line; when it slackens, the form drifts
    // back toward where the composition wants it. Everything on screen that
    // shifts sideways is a cord doing it.
    // ------------------------------------------------------------------
    const CORD_MAX_OFFSET = 9;

    // How long the field takes to cross from one composition to the next.
    // Deliberately longer than the morph itself: the cords finish hauling and
    // the forms are still coasting into place.
    // Longer than before, because the travel is now the piece's resting state
    // rather than an event between still poses: the slow ends of the curve
    // have to last long enough to read as slow.
    const COMP_TRAVEL_MS = 5200;
    // The only pause there is — just enough for the cords to go slack and the
    // arrangement to register before the field sets off again.
    const COMP_HOLD_MS = 650;
    // On ENTRY the field waits longer before its first haul, so the page opens
    // on cords hanging under their own weight and you see them take up.
    const COMP_ENTRY_HOLD_MS = 2200;
    let hasTravelled = false;
    let lastFrameNow = performance.now();
    // when the field last finished arriving, so the relaxation can ring out
    // from that moment rather than from some unrelated clock
    let compArrivedAt = performance.now();

    function stepCordPhysics(dt, pull) {
      const fx = new Float64Array(SLOT_COUNT);
      const fy = new Float64Array(SLOT_COUNT);

      for (let n = 0; n < THREAD_LINKS.length; n++) {
        const link = THREAD_LINKS[n];
        const A = liveShapes[link[0]];
        const B = liveShapes[link[1]];
        if (!A || !B) continue;

        const ax = A.cx + A.ox, ay = A.cy + A.oy;
        const bx = B.cx + B.ox, by = B.cy + B.oy;
        let dx = bx - ax, dy = by - ay;
        const dist = Math.hypot(dx, dy) || 1;
        dx /= dist; dy /= dist;

        // The cord's rest length is the gap the composition asks for. Hauling
        // in shortens it; each cord takes up slack at its own rate so the
        // field doesn't clench as one fist.
        const layout = Math.hypot(B.cx - A.cx, B.cy - A.cy) || 1;
        const bite = 0.10 + (n % 4) * 0.035;
        const rest = layout * (1 - pull * bite);
        const stress = (dist - rest) * 12;

        fx[link[0]] += dx * stress; fy[link[0]] += dy * stress;
        fx[link[1]] -= dx * stress; fy[link[1]] -= dy * stress;
      }

      for (let i = 0; i < SLOT_COUNT; i++) {
        const s = liveShapes[i];
        // spring home + viscous damping keeps the field from running away
        // OVER-damped on purpose. Critical damping for this spring is about
        // 8; anything below that lets the forms overshoot and spring back,
        // and a form that springs back reads as rubber. Above it they are
        // carried and set down, with no bounce and no wind-up before a move.
        s.vx += (fx[i] - s.ox * 16 - s.vx * 12) * dt;
        s.vy += (fy[i] - s.oy * 16 - s.vy * 12) * dt;
        s.ox += s.vx * dt;
        s.oy += s.vy * dt;
        const m = Math.hypot(s.ox, s.oy);
        if (m > CORD_MAX_OFFSET) {
          s.ox = s.ox / m * CORD_MAX_OFFSET;
          s.oy = s.oy / m * CORD_MAX_OFFSET;
          s.vx *= 0.4; s.vy *= 0.4;
        }
      }
    }

    // ------------------------------------------------------------------
    // ABSTRACT SILHOUETTES
    // What makes two forms read as different is not a few percent of wobble —
    // fourteen rounded lumps of one size all look like the same lump. It is
    // SIZE, ELONGATION and above all CONCAVITY: a shape the outline actually
    // bites into cannot be mistaken for the one next to it. So the hollow
    // families here go deep, and the geometric ones stay genuinely flat-sided.
    // ------------------------------------------------------------------
    function superellipse(a, n) {
      return 1 / Math.pow(Math.pow(Math.abs(Math.cos(a)), n) +
                          Math.pow(Math.abs(Math.sin(a)), n), 1 / n);
    }

    function familyProfile(kind, a) {
      switch (kind) {
        case 'blob':
          // no axis of symmetry at all — three uneven swells
          return 0.84 + Math.sin(a * 2 + 0.7) * 0.18 + Math.sin(a * 3 - 1.2) * 0.13;
        case 'bar':
          // hard straight sides; the elongation comes from rx/ry
          return superellipse(a, 7) * 0.92;
        case 'slab':
          // squared with softened corners
          return superellipse(a, 4.4) * 0.88;
        case 'hook':
          // opens right through on one flank — a bracket, not a lump
          return 1 - Math.max(0, Math.cos(a - 0.9)) * 0.76 +
                 Math.max(0, Math.sin(a + 0.4)) * 0.16;
        case 'crescent':
          // deep enough that the hollow is the first thing you see
          return 0.98 - Math.max(0, Math.cos(a)) * 0.74;
        case 'notch':
          // one clean bite out of the side
          return 1 - Math.exp(-Math.pow(((a - 2.1 + Math.PI * 3) % (Math.PI * 2) - Math.PI) / 0.38, 2)) * 0.68;
        case 'ess':
          // swells on opposite flanks at opposite ends
          return 0.86 + Math.sin(a) * 0.14 + Math.sin(a * 2 + 1.1) * 0.26;
        case 'kidney':
          // pinched hard on one flank
          return 1 - Math.max(0, Math.cos(a - 0.6)) * 0.52;
        case 'tongue':
          // broad and blunt at one end, tapering and slightly curved
          return 0.52 + (1 + Math.cos(a)) * 0.34 + Math.sin(a * 2) * 0.09;
        case 'teardrop':
          return 0.56 + (1 + Math.cos(a)) * 0.33;
        case 'arch':
          // domed over, flat along the bottom
          return a > Math.PI * 0.05 && a < Math.PI * 0.95 ? 1 : 0.66;
        case 'wedge':
          // two broad faces meeting in a blunt corner
          return 0.64 + Math.abs(Math.cos(a * 0.5)) * 0.54;
        case 'pill':
          return superellipse(a, 3.2) * 0.9;
        case 'dot':
          return 1;
        default:
          return 1;
      }
    }

    // Per-form irregularity, scaled by that form's own `warp`. The geometric
    // families take none of it, which is what lets the organic ones read as
    // organic instead of everything sharing one texture of wobble.
    function seededWarp(a, seed, amt) {
      if (!amt) return 0;
      return (Math.sin(a * 2 + seed * 1.7) * 0.50
            + Math.sin(a * 3 - seed * 2.3) * 0.34
            + Math.sin(a * 5 + seed * 0.9) * 0.18) * amt;
    }

    function radiusProfile(shape, a) {
      const pa = familyProfile(shape.kindA, a);
      const p = shape.ku >= 1 || shape.kindA === shape.kindB
              ? (shape.ku >= 1 ? familyProfile(shape.kindB, a) : pa)
              : pa + (familyProfile(shape.kindB, a) - pa) * shape.ku;
      const tame = 1 - (shape.tame || 0) * 0.84;
      // A collage form has no `warp` of its own — its edge is cut, not grown
      // — so this falls back to the plain family profile. It is still what
      // the cord anchors are placed on.
      const warp = (shape.form && shape.form.warp) || 0;
      return p * (1 + seededWarp(a, shape.seed, warp * tame));
    }

    // ------------------------------------------------------------------
    // FORMS BUILT OUT OF CIRCLES
    // The reference does not have a wavy edge — it has actual circles stuck
    // together, each one legible as a circle, joined at narrow necks. So
    // that is what these are: a ring of round beads laid along the
    // silhouette, plus a solid core through their centres, all emitted as
    // subpaths of ONE path. With fill-rule: nonzero and every subpath wound
    // the same way, they union into a single solid form.
    //
    // (An earlier attempt modulated the radius with a sine instead. It can't
    // work: as the amplitude rises a sine sharpens its peaks, so the forms
    // came out spiked like stars — the opposite of a bubble.)
    // ------------------------------------------------------------------
    // A rounded rectangle, wound clockwise so it unions with the rest.
    // Rectangles, not circles: the reference's forms are fat ORTHOGONAL
    // strokes — square shoulders pulled round at the corners — and a run of
    // circles can only ever give you scallops. It is the corners that carry
    // the whole character of it.
    // A plain square, wound either way: clockwise it adds, anticlockwise it
    // is subtracted by the nonzero rule.
    function squareSubpath(cx, cy, s, clockwise) {
      const h = s / 2, f = (v) => v.toFixed(1);
      const x = cx - h, y = cy - h;
      return clockwise
        ? ' M ' + f(x) + ' ' + f(y) + ' H ' + f(x + s) + ' V ' + f(y + s) + ' H ' + f(x) + ' Z'
        : ' M ' + f(x) + ' ' + f(y) + ' V ' + f(y + s) + ' H ' + f(x + s) + ' V ' + f(y) + ' Z';
    }

    // Whatever this form is built from — a circle or a rounded block.
    function unitSubpath(kind, cx, cy, w, h, corner) {
      return kind === 'circle'
        ? circleSubpath(cx, cy, Math.min(w, h) / 2)
        : roundRectSubpath(cx, cy, w, h, Math.min(w, h) * corner);
    }

    // Clockwise by default, so it unions with everything else. Wound the
    // other way it is SUBTRACTED by the nonzero rule — which only works for a
    // circle that lies wholly inside the form, and the eyelet does.
    function circleSubpath(cx, cy, r, ccw) {
      const d = (r * 2).toFixed(1);
      const sweep = ccw ? '0' : '1';
      return ' M ' + (cx - r).toFixed(1) + ' ' + cy.toFixed(1) +
             ' a ' + r.toFixed(1) + ' ' + r.toFixed(1) + ' 0 1 ' + sweep + ' ' + d + ' 0' +
             ' a ' + r.toFixed(1) + ' ' + r.toFixed(1) + ' 0 1 ' + sweep + ' -' + d + ' 0 Z';
    }

    function roundRectSubpath(cx, cy, w, h, r) {
      const x = cx - w / 2, y = cy - h / 2;
      r = Math.min(r, w / 2, h / 2);
      const f = (v) => v.toFixed(1);
      const a = (ex, ey) => ' A ' + f(r) + ' ' + f(r) + ' 0 0 1 ' + f(ex) + ' ' + f(ey);
      return ' M ' + f(x + r) + ' ' + f(y) +
             ' H ' + f(x + w - r) + a(x + w, y + r) +
             ' V ' + f(y + h - r) + a(x + w - r, y + h) +
             ' H ' + f(x + r)     + a(x, y + h - r) +
             ' V ' + f(y + r)     + a(x + r, y) + ' Z';
    }

    // Deterministic and stateless: the same form always lays its blocks out
    // the same way, so nothing flickers between frames.
    function formRand(seed, i) {
      const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
      return v - Math.floor(v);
    }

    // A polygon, wound whichever way the caller needs. The winding is worked
    // out from the signed area rather than trusted to the order the corners
    // were written in — a subpath wound the wrong way silently adds where it
    // was meant to subtract.
    function polySubpath(pts, clockwise) {
      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        area += a.x * b.y - b.x * a.y;
      }
      const list = ((area > 0) === clockwise) ? pts : pts.slice().reverse();
      const f = (v) => v.toFixed(1);
      let d = ' M ' + f(list[0].x) + ' ' + f(list[0].y);
      for (let i = 1; i < list.length; i++) d += ' L ' + f(list[i].x) + ' ' + f(list[i].y);
      return d + ' Z';
    }

    // A body: a rectangle with softened corners, turned inside the form.
    // Circular corner arcs carry no orientation of their own, so the whole
    // thing can simply be rotated corner by corner.
    function bodySubpath(cx, cy, w, h, ang, r) {
      const hw = w / 2, hh = h / 2;
      r = Math.min(r, hw, hh);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const P = (x, y) => ({ x: cx + x * ca - y * sa, y: cy + x * sa + y * ca });
      const f = (v) => v.toFixed(1);
      const pts = [
        P(-hw + r, -hh), P(hw - r, -hh), P(hw, -hh + r), P(hw, hh - r),
        P(hw - r, hh),   P(-hw + r, hh), P(-hw, hh - r), P(-hw, -hh + r)
      ];
      if (r <= 0.01) return polySubpath([pts[0], pts[3], pts[4], pts[7]], true);
      const arc = (p) => ' A ' + f(r) + ' ' + f(r) + ' 0 0 1 ' + f(p.x) + ' ' + f(p.y);
      return ' M ' + f(pts[0].x) + ' ' + f(pts[0].y) +
             ' L ' + f(pts[1].x) + ' ' + f(pts[1].y) + arc(pts[2]) +
             ' L ' + f(pts[3].x) + ' ' + f(pts[3].y) + arc(pts[4]) +
             ' L ' + f(pts[5].x) + ' ' + f(pts[5].y) + arc(pts[6]) +
             ' L ' + f(pts[7].x) + ' ' + f(pts[7].y) + arc(pts[0]) + ' Z';
    }

    // WHERE A SYMBOL STANDS. The glyphs are authored in a 100-unit box
    // centred on the origin, so a slot is a translate, a turn and a scale —
    // and the silhouette that was drawn is exactly the silhouette that
    // arrives on the page.
    function pebbleTransform(p, t, idx) {
      const cx = p.cx + p.ox, cy = p.cy + p.oy;
      const R = Math.max(p.rx, 1);
      // a slow breath, and a slow rock: enough that the field is alive,
      // never enough to bend the shape
      const breath = 1 + Math.sin(t * 0.41 + idx * 1.7) * 0.035;
      const spin = p.spin + Math.sin(t * 0.27 + idx * 2.3) * 0.09;
      const s = (R / 50) * breath;
      p.eyeX = cx;
      p.eyeY = cy;
      p.markD = '';
      return 'translate(' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ') ' +
             'rotate(' + (spin * 180 / Math.PI).toFixed(1) + ') ' +
             'scale(' + s.toFixed(3) + ')';
    }

    // SCATTERED STIPPLE.
    // These were hard-coded static circles, so they read as dead specks pinned
    // to the page while everything else moved. Each one now drifts on its own
    // slow loop and is re-aimed on every morph, but always stays inside the
    // composition's bounds so the constellation never sprays across the page.
    const STIPPLE_BOUNDS = { x0: 22, y0: 14, x1: 358, y1: 186 };
    const stippleDots = Array.from(
      document.querySelectorAll('#morph-stipple-dots circle')
    ).map((el, i) => ({
      el,
      x: parseFloat(el.getAttribute('cx')) || 0,
      y: parseFloat(el.getAttribute('cy')) || 0,
      tx: parseFloat(el.getAttribute('cx')) || 0,
      ty: parseFloat(el.getAttribute('cy')) || 0,
      // fixed per-dot phase so the field shimmers instead of pulsing as one
      phase: (i * 1.37) % (Math.PI * 2),
      speed: 0.22 + (i % 5) * 0.06
    }));

    function clampToBounds(v, lo, hi) {
      return v < lo ? lo : (v > hi ? hi : v);
    }

    // Dots must sit ON the colour fields, never adrift on bare ground. Each
    // new target is tested against the actual filled shapes and rejected if it
    // lands outside; the blocks' bounding boxes are the fallback when the
    // browser cannot hit-test the path.
    const hitPoint = svg.createSVGPoint ? svg.createSVGPoint() : null;

    function insideFields(x, y) {
      if (!hitPoint) return null; // cannot test — caller falls back
      hitPoint.x = x;
      hitPoint.y = y;
      try {
        if (blobPath && blobPath.isPointInFill && blobPath.isPointInFill(hitPoint)) return true;
        if (blobUnder && blobUnder.isPointInFill && blobUnder.isPointInFill(hitPoint)) return true;
      } catch (e) {
        return null;
      }
      return false;
    }

    function fieldBox() {
      // union of whatever the two fields currently occupy
      let b = null;
      [blobPath, blobUnder].forEach(el => {
        if (!el) return;
        let r;
        try { r = el.getBBox(); } catch (e) { return; }
        if (!r || !r.width || !r.height) return;
        b = b ? {
          x0: Math.min(b.x0, r.x), y0: Math.min(b.y0, r.y),
          x1: Math.max(b.x1, r.x + r.width), y1: Math.max(b.y1, r.y + r.height)
        } : { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
      });
      return b || STIPPLE_BOUNDS;
    }

    function retargetStipple() {
      const box = fieldBox();
      const inset = 4; // keep clear of the very edge of a block
      stippleDots.forEach(d => {
        d.x = d.tx;
        d.y = d.ty;

        let nx = d.x, ny = d.y, placed = false;
        for (let attempt = 0; attempt < 14; attempt++) {
          const cx = clampToBounds(d.x + (Math.random() - 0.5) * 46, box.x0 + inset, box.x1 - inset);
          const cy = clampToBounds(d.y + (Math.random() - 0.5) * 34, box.y0 + inset, box.y1 - inset);
          const hit = insideFields(cx, cy);
          if (hit === null) { nx = cx; ny = cy; placed = true; break; } // no hit-testing available
          if (hit) { nx = cx; ny = cy; placed = true; break; }
        }
        if (!placed) {
          // nothing landed inside — drop it near the middle of the blocks
          nx = (box.x0 + box.x1) / 2 + (Math.random() - 0.5) * (box.x1 - box.x0) * 0.4;
          ny = (box.y0 + box.y1) / 2 + (Math.random() - 0.5) * (box.y1 - box.y0) * 0.4;
        }
        d.tx = nx;
        d.ty = ny;
      });
    }

    // 5 RICH AMORPHOUS POSTER STATES (380 x 200 VIEWBOX)
    const SHAPES = [
      // STATE 0: Supernova Constellation
      {
        core: { x: 215, y: 98, r: 6.5, ringR: 14 },
        nodes: [
          { x: 45, y: 52, r: 6.5 },
          { x: 100, y: 26, r: 6 },
          { x: 165, y: 18, r: 6.5 },
          { x: 235, y: 22, r: 6 },
          { x: 300, y: 35, r: 6.5 },
          { x: 348, y: 72, r: 6 },
          { x: 355, y: 130, r: 7 },
          { x: 318, y: 170, r: 6 },
          { x: 252, y: 178, r: 6.5 },
          { x: 180, y: 176, r: 6 },
          { x: 110, y: 162, r: 6.5 },
          { x: 50, y: 118, r: 6 }
        ],
        rings: [
          { x: 75, y: 82, r: 12, color: 'var(--c-flame-orange)' },
          { x: 295, y: 98, r: 14, color: 'var(--c-hot-pink)' },
          { x: 140, y: 135, r: 8.5, color: 'var(--c-electric-blue)' },
          { x: 245, y: 48, r: 10.5, color: 'var(--c-pixel-green)' }
        ],
        blob: [
          { x: 38, y: 48 }, { x: 96, y: 20 }, { x: 165, y: 12 }, { x: 238, y: 16 },
          { x: 305, y: 28 }, { x: 355, y: 68 }, { x: 362, y: 132 }, { x: 322, y: 176 },
          { x: 255, y: 184 }, { x: 178, y: 182 }, { x: 104, y: 168 }, { x: 42, y: 120 }
        ],
        ribbon: [
          { x: 45, y: 52 }, { x: 165, y: 18 }, { x: 215, y: 98 }, { x: 252, y: 178 }, { x: 110, y: 162 }
        ]
      },

      // STATE 1: Organic Amoeba & Nucleus
      {
        core: { x: 175, y: 102, r: 7, ringR: 16 },
        nodes: [
          { x: 95, y: 52, r: 6.5 },
          { x: 158, y: 36, r: 6 },
          { x: 228, y: 40, r: 6.5 },
          { x: 290, y: 62, r: 6 },
          { x: 312, y: 105, r: 6.5 },
          { x: 290, y: 152, r: 6 },
          { x: 228, y: 172, r: 7 },
          { x: 165, y: 165, r: 6 },
          { x: 115, y: 160, r: 6.5 },
          { x: 72, y: 132, r: 6 },
          { x: 62, y: 82, r: 6.5 },
          { x: 120, y: 92, r: 6 }
        ],
        rings: [
          { x: 120, y: 92, r: 14, color: 'var(--c-flame-orange)' },
          { x: 228, y: 40, r: 10, color: 'var(--c-pixel-green)' },
          { x: 228, y: 172, r: 13, color: 'var(--c-hot-pink)' },
          { x: 72, y: 132, r: 9, color: 'var(--c-electric-blue)' }
        ],
        blob: [
          { x: 88, y: 45 }, { x: 158, y: 30 }, { x: 232, y: 34 }, { x: 300, y: 55 },
          { x: 322, y: 105 }, { x: 300, y: 158 }, { x: 232, y: 180 }, { x: 165, y: 172 },
          { x: 110, y: 166 }, { x: 65, y: 135 }, { x: 54, y: 80 }, { x: 72, y: 52 }
        ],
        ribbon: [
          { x: 62, y: 82 }, { x: 120, y: 92 }, { x: 175, y: 102 }, { x: 290, y: 62 }, { x: 228, y: 172 }
        ]
      },

      // STATE 2: Harmonic Arched Wave
      {
        core: { x: 95, y: 68, r: 7, ringR: 15 },
        nodes: [
          { x: 42, y: 155, r: 6.5 },
          { x: 85, y: 78, r: 6 },
          { x: 128, y: 155, r: 6.5 },
          { x: 175, y: 45, r: 6.5 },
          { x: 225, y: 155, r: 6.5 },
          { x: 275, y: 72, r: 6 },
          { x: 322, y: 155, r: 7 },
          { x: 355, y: 102, r: 6 },
          { x: 308, y: 174, r: 6.5 },
          { x: 210, y: 178, r: 6 },
          { x: 145, y: 176, r: 6.5 },
          { x: 58, y: 172, r: 6 }
        ],
        rings: [
          { x: 175, y: 45, r: 15, color: 'var(--c-flame-orange)' },
          { x: 85, y: 78, r: 10, color: 'var(--c-electric-blue)' },
          { x: 275, y: 72, r: 11.5, color: 'var(--c-hot-pink)' },
          { x: 225, y: 155, r: 9, color: 'var(--c-pixel-green)' }
        ],
        blob: [
          { x: 35, y: 155 }, { x: 85, y: 68 }, { x: 128, y: 150 }, { x: 175, y: 38 },
          { x: 225, y: 150 }, { x: 275, y: 65 }, { x: 325, y: 150 }, { x: 362, y: 100 },
          { x: 312, y: 180 }, { x: 210, y: 184 }, { x: 145, y: 182 }, { x: 52, y: 178 }
        ],
        ribbon: [
          { x: 42, y: 155 }, { x: 85, y: 78 }, { x: 128, y: 155 }, { x: 175, y: 45 }, { x: 322, y: 155 }
        ]
      },

      // STATE 3: 8-Bit Chamfered Polygon
      {
        core: { x: 275, y: 122, r: 6.5, ringR: 14 },
        nodes: [
          { x: 68, y: 26, r: 6.5 },
          { x: 165, y: 26, r: 6 },
          { x: 245, y: 48, r: 6.5 },
          { x: 320, y: 48, r: 6 },
          { x: 345, y: 88, r: 6.5 },
          { x: 345, y: 148, r: 6 },
          { x: 300, y: 180, r: 7 },
          { x: 202, y: 180, r: 6 },
          { x: 128, y: 155, r: 6.5 },
          { x: 52, y: 155, r: 6 },
          { x: 30, y: 115, r: 6.5 },
          { x: 30, y: 62, r: 6 }
        ],
        rings: [
          { x: 165, y: 92, r: 13, color: 'var(--c-electric-blue)' },
          { x: 245, y: 122, r: 10, color: 'var(--c-pixel-green)' },
          { x: 95, y: 88, r: 9, color: 'var(--c-flame-orange)' },
          { x: 300, y: 72, r: 13, color: 'var(--c-hot-pink)' }
        ],
        blob: [
          { x: 62, y: 22 }, { x: 168, y: 22 }, { x: 250, y: 44 }, { x: 326, y: 44 },
          { x: 352, y: 85 }, { x: 352, y: 152 }, { x: 305, y: 185 }, { x: 202, y: 185 },
          { x: 122, y: 160 }, { x: 46, y: 160 }, { x: 24, y: 115 }, { x: 24, y: 58 }
        ],
        ribbon: [
          { x: 30, y: 62 }, { x: 95, y: 88 }, { x: 165, y: 92 }, { x: 275, y: 122 }, { x: 345, y: 88 }
        ]
      },

      // STATE 4: Radial Blossom
      {
        core: { x: 188, y: 96, r: 6.5, ringR: 15 },
        nodes: [
          { x: 188, y: 32, r: 6.5 },
          { x: 258, y: 45, r: 6 },
          { x: 305, y: 82, r: 6.5 },
          { x: 316, y: 136, r: 6 },
          { x: 278, y: 174, r: 6.5 },
          { x: 212, y: 182, r: 6 },
          { x: 145, y: 168, r: 7 },
          { x: 92, y: 136, r: 6 },
          { x: 68, y: 85, r: 6.5 },
          { x: 106, y: 48, r: 6 },
          { x: 155, y: 68, r: 6.5 },
          { x: 235, y: 118, r: 6 }
        ],
        rings: [
          { x: 188, y: 96, r: 16, color: 'var(--c-flame-orange)' },
          { x: 305, y: 82, r: 10, color: 'var(--c-hot-pink)' },
          { x: 92, y: 136, r: 12, color: 'var(--c-pixel-green)' },
          { x: 155, y: 68, r: 9, color: 'var(--c-electric-blue)' }
        ],
        blob: [
          { x: 188, y: 26 }, { x: 265, y: 40 }, { x: 315, y: 80 }, { x: 326, y: 140 },
          { x: 284, y: 180 }, { x: 212, y: 188 }, { x: 140, y: 174 }, { x: 84, y: 140 },
          { x: 60, y: 82 }, { x: 100, y: 42 }, { x: 152, y: 62 }, { x: 192, y: 70 }
        ],
        ribbon: [
          { x: 68, y: 85 }, { x: 155, y: 68 }, { x: 188, y: 96 }, { x: 235, y: 118 }, { x: 278, y: 174 }
        ]
      }
    ];

    // CONSTELLATION CHORDS
    // Dashed chords and floating rings left over from the bio-map animation
    // this grew out of. They are strung between nodes that no longer stand
    // for anything, so on the poster field they were just four more lines
    // crossing it — the clutter, not the composition. Empty, the render loop
    // that drives them does nothing.
    const CONSTELLATION_CHORDS = [];

    // Fixed hand-drawn bow per spoke, in viewBox units. Uneven on purpose.
    const SPOKE_BOW = [2.6, -3.4, 1.8, -2.2, 3.1, -1.6, 2.4, -3.0, 1.4, -2.7, 3.3, -1.9];

    // BUILD INITIAL DOM ELEMENTS INSIDE SVG
    // 1. Spoke lines (12 lines from core to satellites in solid white)
    const spokeLines = [];
    if (spokesGroup) {
      spokesGroup.innerHTML = '';
      // Paths, not <line>: a ruler-straight ray is the giveaway that this was
      // plotted rather than drawn. Each spoke gets a slight, fixed bow.
      for (let i = 0; i < THREAD_LINKS.length; i++) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'morph-spoke-line');
        spokesGroup.appendChild(path);
        spokeLines.push(path);
      }
    }

    // 2. Open Constellation Chords
    const webLines = [];
    if (webGroup) {
      webGroup.innerHTML = '';
      CONSTELLATION_CHORDS.forEach((chord) => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'morph-web-line');
        line.setAttribute('stroke-dasharray', chord.dash);
        line.setAttribute('stroke', chord.color);
        line.setAttribute('opacity', '0.65');
        webGroup.appendChild(line);
        webLines.push({ el: line, from: chord.from, to: chord.to });
      });
    }

    // 3. Floating Rings (4 rings)
    const ringCircles = [];
    if (ringsGroup) ringsGroup.innerHTML = '';

    // 4. Anchor dots — one per thread, so no cord starts without a node.
    const satelliteDots = [];
    if (satellitesGroup) {
      satellitesGroup.innerHTML = '';
      for (let i = 0; i < THREAD_LINKS.length; i++) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('class', 'morph-satellite-dot');
        circle.setAttribute('r', '6');
        satellitesGroup.appendChild(circle);
        satelliteDots.push(circle);
      }
    }

    // SPLINE GENERATORS (Catmull-Rom to Cubic Bezier)
    function getClosedSplinePath(pts, tension = 0.33) {
      if (!pts || pts.length < 3) return '';
      const n = pts.length;
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 0; i < n; i++) {
        const pPrev = pts[(i - 1 + n) % n];
        const pCurr = pts[i];
        const pNext = pts[(i + 1) % n];
        const pNextNext = pts[(i + 2) % n];

        const cp1x = pCurr.x + (pNext.x - pPrev.x) * tension;
        const cp1y = pCurr.y + (pNext.y - pPrev.y) * tension;
        const cp2x = pNext.x - (pNextNext.x - pCurr.x) * tension;
        const cp2y = pNext.y - (pNextNext.y - pCurr.y) * tension;

        d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${pNext.x.toFixed(1)} ${pNext.y.toFixed(1)}`;
      }
      return d + ' Z';
    }

    function getOpenSplinePath(pts, tension = 0.35) {
      if (!pts || pts.length < 2) return '';
      if (pts.length === 2) {
        return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
      }
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = i > 0 ? pts[i - 1] : pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = i < pts.length - 2 ? pts[i + 2] : p2;

        const cp1x = p1.x + (p2.x - p0.x) * tension;
        const cp1y = p1.y + (p2.y - p0.y) * tension;
        const cp2x = p2.x - (p3.x - p1.x) * tension;
        const cp2y = p2.y - (p3.y - p1.y) * tension;

        d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
      }
      return d;
    }

    // 8-Bit Stepped Staircase Contour (Bio-Map & Festival MV Aesthetics)
    function getSteppedPath(pts, step = 6) {
      if (!pts || pts.length < 3) return '';
      const snap = (v) => Math.round(v / step) * step;
      let d = `M ${snap(pts[0].x)} ${snap(pts[0].y)}`;
      for (let i = 0; i < pts.length; i++) {
        const pNext = pts[(i + 1) % pts.length];
        const tx = snap(pNext.x);
        const ty = snap(pNext.y);
        d += ` H ${tx} V ${ty}`;
      }
      return d + ' Z';
    }

    // Bouncing Parabolic Arches (Festival MV Jumping Wave Signature)
    function getBouncingArchesPath(pts) {
      if (!pts || pts.length < 2) return '';
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const midX = (p1.x + p2.x) / 2;
        const dist = Math.abs(p2.x - p1.x);
        const hBounce = Math.min(Math.max(dist * 0.75, 20), 45);
        const archY = Math.min(p1.y, p2.y) - hBounce;
        d += ` Q ${midX.toFixed(1)} ${archY.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
      }
      return d;
    }

    // ARRAYS & TIMINGS
    const DRIFT_DURATION = 6400;
    const MORPH_DURATION = 2800;

    let currentIdx = 0;
    let targetIdx = 1;
    let phase = 'drift';
    let phaseStartTime = performance.now();

    // Field colours taken off the HFBK Hamburg programme grid: bright, flat
    // screen colours — green, orange, blue, magenta, cyan, yellow — always
    // carrying black type on top.
    const PALETTE_PAIRS = [
      { a: '#3CB54A', b: '#F5821F' }, // green over orange
      { a: '#2E7FE8', b: '#FF3DDB' }, // blue over magenta
      { a: '#D4FF00', b: '#5FFBD8' }, // yellow over aqua
      { a: '#FF3DDB', b: '#FFC8D8' }, // magenta over pale pink
      { a: '#F5821F', b: '#2E7FE8' }, // orange over blue
      { a: '#5FFBD8', b: '#3CB54A' }  // aqua over green
    ];
    let paletteIdx = 0;

    function applyPalette(i) {
      const pair = PALETTE_PAIRS[i % PALETTE_PAIRS.length];
      const root = document.documentElement;
      root.style.setProperty('--morph-field-a', pair.a);
      root.style.setProperty('--morph-field-b', pair.b);
    }
    applyPalette(paletteIdx);

    function aggressiveEasyEase(t) {
      if (t < 0.35) {
        const localT = t / 0.35;
        return 0.5 * Math.pow(localT, 5) * 0.15;
      } else if (t < 0.7) {
        const localT = (t - 0.35) / 0.35;
        return 0.075 + 0.85 * (0.5 - 0.5 * Math.cos(localT * Math.PI));
      } else {
        const localT = (t - 0.7) / 0.3;
        return 0.925 + 0.075 * (1 - Math.pow(1 - localT, 4));
      }
    }

    function triggerNextMorph() {
      if (phase === 'morph') return;
      phase = 'morph';
      phaseStartTime = performance.now();
      targetIdx = (currentIdx + 1) % SHAPES.length;
    }

    if (wrap) {
      wrap.addEventListener('click', triggerNextMorph);
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerNextMorph();
        }
      });
    }

    function renderFrame(now) {
      const elapsed = now - phaseStartTime;
      let ease = 0;

      if (phase === 'drift') {
        if (elapsed > DRIFT_DURATION) {
          phase = 'morph';
          phaseStartTime = now;
          targetIdx = (currentIdx + 1) % SHAPES.length;
          retargetStipple();
        }
      } else if (phase === 'morph') {
        const linearT = Math.min(elapsed / MORPH_DURATION, 1);
        ease = aggressiveEasyEase(linearT);
        if (linearT >= 1) {
          phase = 'drift';
          phaseStartTime = now;
          currentIdx = targetIdx;
          // The palette does NOT advance. Nothing in this field changes
          // colour: the fills, the hoops and the cords are fixed, and only
          // position, silhouette and tension move.
        }
      }

      const curShape = SHAPES[currentIdx];
      const tgtShape = SHAPES[targetIdx];
      const tSec = now * 0.0015;

      // 1. Core Node
      const curCore = phase === 'morph' ? curShape.core : SHAPES[currentIdx].core;
      const tgtCore = phase === 'morph' ? tgtShape.core : curCore;
      const coreX = curCore.x + (tgtCore.x - curCore.x) * ease + Math.sin(tSec) * 1.1;
      const coreY = curCore.y + (tgtCore.y - curCore.y) * ease + Math.cos(tSec * 1.1) * 1.1;
      const coreR = curCore.r + (tgtCore.r - curCore.r) * ease;
      const coreRingR = curCore.ringR + (tgtCore.ringR - curCore.ringR) * ease + Math.sin(tSec * 2) * 0.6;

      if (coreDot) {
        coreDot.setAttribute('cx', coreX.toFixed(1));
        coreDot.setAttribute('cy', coreY.toFixed(1));
        coreDot.setAttribute('r', coreR.toFixed(1));
      }
      if (coreRing) {
        coreRing.setAttribute('cx', coreX.toFixed(1));
        coreRing.setAttribute('cy', coreY.toFixed(1));
        coreRing.setAttribute('r', coreRingR.toFixed(1));
      }
      if (coreRingOuter) {
        coreRingOuter.setAttribute('cx', coreX.toFixed(1));
        coreRingOuter.setAttribute('cy', coreY.toFixed(1));
        coreRingOuter.setAttribute('r', (coreRingR + 10).toFixed(1));
      }

      // 2. Satellite Nodes & Spokes (Festival MV Thick White Beams)
      const curNodes = phase === 'morph' ? curShape.nodes : SHAPES[currentIdx].nodes;
      const tgtNodes = phase === 'morph' ? tgtShape.nodes : curNodes;
      const computedNodes = [];

      // Drift the stipple field toward its current targets, with a small
      // per-dot orbit on top so it never settles into a dead pose.
      const stippleBox = fieldBox();
      stippleDots.forEach(d => {
        const gx = d.x + (d.tx - d.x) * ease;
        const gy = d.y + (d.ty - d.y) * ease;
        const ox = Math.sin(tSec * d.speed + d.phase) * 2.6;
        const oy = Math.cos(tSec * d.speed * 1.15 + d.phase) * 2.0;
        // small orbit, and clamped to the blocks so it cannot drift off them
        const fb = stippleBox;
        d.el.setAttribute('cx', clampToBounds(gx + ox, fb.x0 + 3, fb.x1 - 3).toFixed(1));
        d.el.setAttribute('cy', clampToBounds(gy + oy, fb.y0 + 3, fb.y1 - 3).toFixed(1));
      });

      // THREAD TENSION.
      // The spokes behave like strings: on each morph they are pulled taut —
      // overshooting outward from the core — and then relax back and settle,
      // with a small damped wobble instead of stopping dead. During the quiet
      // drift phase they breathe very slightly so they never look frozen.
      let tension;
      if (phase === 'morph') {
        const t = Math.min((now - phaseStartTime) / MORPH_DURATION, 1);
        // peaks early (the pull), then decays away (the release)
        tension = Math.sin(Math.PI * t) * Math.exp(-1.5 * t) * 0.13;
      } else {
        const settle = Math.min((now - phaseStartTime) / 900, 1);
        // damped ring-out right after the snap, then a slow breath
        tension = Math.cos(settle * Math.PI * 3) * Math.exp(-3.2 * settle) * 0.045
                + Math.sin(tSec * 0.8) * 0.012;
      }

      const pendingThreads = [];
      for (let i = 0; i < 12; i++) {
        const cN = curNodes[i];
        const tN = tgtNodes[i];
        const driftX = Math.sin(tSec + i * 0.5) * 1.2;
        const driftY = Math.cos(tSec * 1.1 + i * 0.6) * 1.2;
        let nx = cN.x + (tN.x - cN.x) * ease + driftX;
        let ny = cN.y + (tN.y - cN.y) * ease + driftY;
        const nr = cN.r + (tN.r - cN.r) * ease;

        // Stretch each node along its own radius from the core, so the whole
        // fan tightens and loosens together rather than sliding sideways.
        // Staggered per spoke so they don't snap in unison.
        const stagger = 1 + Math.sin(i * 1.7) * 0.35;
        const pull = 1 + tension * stagger;
        nx = coreX + (nx - coreX) * pull;
        ny = coreY + (ny - coreY) * pull;

        computedNodes.push({ x: nx, y: ny });

        if (satelliteDots[i]) {
          satelliteDots[i].setAttribute('cx', nx.toFixed(1));
          satelliteDots[i].setAttribute('cy', ny.toFixed(1));
          satelliteDots[i].setAttribute('r', nr.toFixed(1));
        }

        if (spokeLines[i]) {
          // Threads are strung POINT TO POINT across the composition: each one
          // runs from its own node to the node roughly opposite, so both ends
          // are anchored at the edges rather than all meeting in the middle.
          // Drawn later, once every node position for this frame is known.
          pendingThreads.push(i);
        }
      }

      // Advance the travel first: the haul is a function of HOW FAR ALONG the
      // field is, not of a separate clock.
      //
      // The field used to arrive and then sit for the rest of the morph cycle,
      // which is what made it look like the forms were dawdling. It now runs
      // on its own clock and sets off again the moment the hold is up, so the
      // piece is always travelling.
      if (compU < 1) {
        compU = Math.min(1, compU + (now - lastFrameNow) / COMP_TRAVEL_MS);
        // Stamp the arrival HERE, on the frame it actually happens. Stamped
        // after the tension was read, the first settled frame measured its
        // ring-out from compArrivedAt = -1 — an age ago — and produced one
        // stray frame of wrong tension.
        if (compU >= 1) compArrivedAt = now;
      } else if (compArrivedAt > 0 &&
                 now - compArrivedAt > (hasTravelled ? COMP_HOLD_MS : COMP_ENTRY_HOLD_MS)) {
        hasTravelled = true;
        // Parked on one arrangement, the field travels TO ITSELF: the forms
        // stay where they are and the cords still haul and release. Held at
        // rest instead, a pinned composition sat with every cord fully slack
        // for ever, which is not what it looks like.
        travelToComposition(compLocked ? compTo : compTo + 1, false);
      }
      updateLiveShapes();

      // HOW HARD THE CORDS ARE HAULING, THIS FRAME.
      // Everything below is downstream of this one number: it sets how far
      // the strings drag the forms, how much the forms stretch, and how much
      // bow is left in the line.
      //
      // It is driven by compU, not by the morph clock. The two used to run on
      // separate timers, so the cords let go somewhere in the middle of the
      // journey and the forms coasted the rest of the way on nothing. Tied to
      // the travel, the release lands exactly as the arrangement arrives: haul
      // on, carry, and go slack on the last stretch into position.
      let pull;
      if (compU < 1) {
        const u = compU;
        if (u < 0.18) pull = Math.pow(u / 0.18, 0.55);          // take up the slack
        else if (u < 0.70) pull = 1 - Math.sin((u - 0.18) / 0.52 * Math.PI) * 0.06; // carry
        else pull = Math.pow(1 - (u - 0.70) / 0.30, 2.2);        // let go on arrival
      } else {
        // settled: a slow breath, plus a short ring-out right after arrival
        // Settled: the ring-out from the arrival dies away and what is left
        // is a slow breath at almost no tension, so the cords sit at close to
        // full sag between one arrangement and the next.
        //
        // The ring STARTS AT ZERO (sine, not cosine). With a cosine it opened
        // at full amplitude, so on the single frame the travel ended the
        // tension jumped 0 -> 0.18 and every cord snapped taut for one frame
        // before falling slack again. That was the hitch in the slack phase.
        const st = (now - compArrivedAt) / 1000;
        const ring = Math.max(0, Math.sin(st * Math.PI * 1.5) * Math.exp(-2.0 * st)) * 0.18;
        const sway = 0.018 + Math.sin(tSec * 0.28) * 0.012 + Math.sin(tSec * 0.11 + 1.3) * 0.008;
        pull = Math.max(ring, sway);
      }
      const slack = 1 - pull;
      // The works index hangs off this same number, so the two sets of cords
      // take up and go slack on exactly the same beat.
      cordPull = pull;
      if (document.body.classList.contains('stage-works')) drawWorksCords();

      // dt is clamped: a backgrounded tab hands back a gap of seconds, and an
      // unclamped step would fire every form off the page in one frame.
      const dt = Math.min((now - lastFrameNow) / 1000, 1 / 30);
      lastFrameNow = now;
      if (dt > 0) stepCordPhysics(dt, pull);

      pebbleEls.forEach((el, i) => {
        // built ONCE and handed to every layer — the path is the expensive
        // part of the frame, and four copies of it would be four times the
        // cost for no difference on screen
        // The symbol never changes shape. Only where it stands, how big it
        // is and which way it faces.
        el.setAttribute('transform', pebbleTransform(liveShapes[i], tSec, i));
        // pebblePath fills markD as it goes, so this reads what it just built
        if (pebbleMarkEls[i]) pebbleMarkEls[i].setAttribute('d', liveShapes[i].markD || '');
      });

      const rings2 = liveRings();
      compRingEls.forEach((el, i) => {
        el.setAttribute('cx', rings2[i].cx.toFixed(1));
        el.setAttribute('cy', rings2[i].cy.toFixed(1));
        el.setAttribute('rx', rings2[i].rx.toFixed(1));
        el.setAttribute('ry', rings2[i].ry.toFixed(1));
      });

      // STRING THE THREADS.
      // Each one runs between two SHAPES and bows around them, so the field
      // reads as cords wrapped over strewn forms rather than a star with a
      // hub. `slack` drives taut-versus-hanging.
      // Where a thread meets a shape. `grip` pulls the point inside the
      // silhouette rather than onto its exact edge: the drawn outline is a
      // smoothed spline through the sample points, so a point computed at the
      // raw radius can fall just outside the curve — which is what left the
      // black anchors floating free of the forms.
      // Where a cord meets a shape: its eyelet, and nowhere else. The hole
      // is stamped by pebblePath in the same frame, so this reads the exact
      // point that was just drawn — tremor and all — and the cord end can
      // never drift off the shape.
      function eyeletPoint(p) {
        return {
          x: p.eyeX !== undefined ? p.eyeX : p.cx + p.ox,
          y: p.eyeY !== undefined ? p.eyeY : p.cy + p.oy
        };
      }

      THREAD_LINKS.forEach((link, i) => {
        const el = spokeLines[i];
        if (!el) return;
        const A = liveShapes[link[0]];
        const B = liveShapes[link[1]];
        if (!A || !B) return;

        const base = Math.atan2((B.cy + B.oy) - (A.cy + A.oy),
                                (B.cx + B.ox) - (A.cx + A.ox));
        const a = eyeletPoint(A);
        const b = eyeletPoint(B);

        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;

        // two control points on alternating sides make the cord curl around
        // the forms rather than cutting straight past them
        const side = (i % 2) ? 1 : -1;
        // The reference reads as taut string: only a slight bow, so the cords
        // cross as long straight diagonals instead of curling loops.
        // Taut. The reference's chords are dead straight lines crossing
        // between the bodies, so the bow is a fraction of what it was and
        // the sag below is nearly gone with it.
        const bow = (0.5 + (i % 5) * 0.32) * (0.3 + slack * 0.7) * side;

        // GRAVITY.
        // A slack cord does not just bow sideways, it HANGS — and a long one
        // hangs deeper than a short one. The sag is always downward in screen
        // space, never along the cord's own normal, which is what makes it
        // read as weight rather than as another curl. It grows faster than
        // the slack itself (the square), so a cord that is only slightly
        // loose stays nearly straight while a fully released one drops right
        // open. Hauled taut, slack is ~0 and this term vanishes.
        const sag = slack * slack * len * 0.045 * (0.75 + (i % 4) * 0.17);

        const c1x = a.x + dx * 0.3 + px * bow;
        const c1y = a.y + dy * 0.3 + py * bow + sag;
        const c2x = a.x + dx * 0.7 - px * bow * 0.55;
        const c2y = a.y + dy * 0.7 - py * bow * 0.55 + sag;

        el.setAttribute('d',
          'M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
          ' C ' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) +
          ', ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) +
          ', ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1));

        // No anchor dot any more: the cord ends inside a hole, and a dot
        // drawn on top of it would simply plug the hole back up.
        const dot = satelliteDots[i];
        if (dot) dot.setAttribute('r', '0');
      });

      // 3. Update Web & Bio-Map Internal Cellular Chords
      webLines.forEach(w => {
        const p1 = computedNodes[w.from];
        const p2 = computedNodes[w.to];
        if (p1 && p2) {
          w.el.setAttribute('x1', p1.x.toFixed(1));
          w.el.setAttribute('y1', p1.y.toFixed(1));
          w.el.setAttribute('x2', p2.x.toFixed(1));
          w.el.setAttribute('y2', p2.y.toFixed(1));
        }
      });

      // 4. Interpolate Floating Rings
      const curRings = phase === 'morph' ? curShape.rings : SHAPES[currentIdx].rings;
      const tgtRings = phase === 'morph' ? tgtShape.rings : curRings;

      for (let i = 0; i < 4; i++) {
        const cR = curRings[i];
        const tR = tgtRings[i];
        const rx = cR.x + (tR.x - cR.x) * ease + Math.sin(tSec * 1.3 + i) * 1.3;
        const ry = cR.y + (tR.y - cR.y) * ease + Math.cos(tSec * 1.2 + i) * 1.3;
        const rr = cR.r + (tR.r - cR.r) * ease;

        if (ringCircles[i]) {
          ringCircles[i].setAttribute('cx', rx.toFixed(1));
          ringCircles[i].setAttribute('cy', ry.toFixed(1));
          ringCircles[i].setAttribute('r', rr.toFixed(1));
          ringCircles[i].setAttribute('stroke', cR.color);
        }
      }

      // 5. Interpolate Lower Horizon Stepped Shape (Festival MV Cyan/Green)
      if (blobUnder) {
        const lowerIndices = [11, 10, 9, 8, 7, 6];
        const bPts = lowerIndices.map(idx => computedNodes[idx]).filter(Boolean).sort((a, b) => a.x - b.x);
        if (bPts.length >= 3) {
          const underPts = [
            { x: 30, y: 195 },
            ...bPts,
            { x: 350, y: 195 }
          ];
          const underD = getClosedSplinePath(underPts, 0.42); // soft pebble, not a staircase
          blobUnder.setAttribute('d', underD);
        }
      }

      // 6. Interpolate Festival MV Bouncing White Parabolic Arches
      if (archesPath) {
        const archIndices = [11, 10, 9, 8, 7, 6];
        const archPts = archIndices.map(idx => computedNodes[idx]).filter(Boolean).sort((a, b) => a.x - b.x);
        if (archPts.length >= 2) {
          const dArch = getBouncingArchesPath(archPts);
          archesPath.setAttribute('d', dArch);
        }
      }

      // 7. Interpolate Primary Stepped 8-Bit Dither Cloud (Bio-Map & Festival MV)
      const curBlob = phase === 'morph' ? curShape.blob : SHAPES[currentIdx].blob;
      const tgtBlob = phase === 'morph' ? tgtShape.blob : curBlob;
      const computedBlob = [];

      for (let i = 0; i < 12; i++) {
        const cB = curBlob[i];
        const tB = tgtBlob[i];
        const bx = cB.x + (tB.x - cB.x) * ease + Math.sin(tSec * 1.1 + i * 0.7) * 1.4;
        const by = cB.y + (tB.y - cB.y) * ease + Math.cos(tSec * 0.9 + i * 0.8) * 1.4;
        computedBlob.push({ x: bx, y: by });
      }

      if (blobPath) {
        const blobD = getClosedSplinePath(computedBlob, 0.44); // soft pebble, not a staircase
        blobPath.setAttribute('d', blobD);
      }

      // 8. Interpolate Organic Ribbon
      const curRibbon = phase === 'morph' ? curShape.ribbon : SHAPES[currentIdx].ribbon;
      const tgtRibbon = phase === 'morph' ? tgtShape.ribbon : curRibbon;
      const computedRibbon = [];

      for (let i = 0; i < curRibbon.length; i++) {
        const cP = curRibbon[i];
        const tP = tgtRibbon[i];
        const rx = cP.x + (tP.x - cP.x) * ease + Math.sin(tSec * 1.4 + i) * 1.3;
        const ry = cP.y + (tP.y - cP.y) * ease + Math.cos(tSec * 1.2 + i) * 1.3;
        computedRibbon.push({ x: rx, y: ry });
      }

      if (ribbonPath) {
        const ribbonD = getOpenSplinePath(computedRibbon, 0.35);
        ribbonPath.setAttribute('d', ribbonD);
      }

      requestAnimationFrame(renderFrame);
    }

    requestAnimationFrame(renderFrame);
  }

  // ------------------------------------------------------------------------
  // RISO FLICKER
  // The grain moves. A still grain reads as dirt on the page; a moving one
  // reads as film. The seed on each feTurbulence is stepped, not the whole
  // filter rebuilt, which is the cheap way to get a new noise field.
  //
  // It runs at about eight steps a second rather than every frame. Full
  // frame rate costs a complete re-render of two screen-sized turbulence
  // fields sixty times a second for no visible gain — at eight it already
  // reads as flicker and leaves the budget to the animation.
  // ------------------------------------------------------------------------
  function initRisoFlicker() {
    const turbs = document.querySelectorAll('.riso-grain feTurbulence');
    if (!turbs.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const STEP_MS = 125;
    let last = 0;
    let n = 0;

    function tick(now) {
      if (now - last >= STEP_MS) {
        last = now;
        n++;
        turbs.forEach((t, i) => {
          // a different sequence per layer, so the two grains never line up
          t.setAttribute('seed', String((n * 7 + i * 31) % 97));
        });
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  initRisoFlicker();

  // Initialize Amorphous Hero Morphing Engine
  initHeroAmorphousMorph();
});
