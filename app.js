// ============================================================================
// info cc 404 — Single Page Application (app.js)
// Plain JavaScript + Supabase, Hash Routing, PDF.js view-only viewer
// Clean typography, zero emojis, strict role division, minimal #/admin & #/upload
// ============================================================================

// 1. CONFIG CHECK
const rootEl = document.getElementById("appRoot");

if (!window.INFOCC_CONFIG || !window.INFOCC_CONFIG.SUPABASE_URL || !window.INFOCC_CONFIG.SUPABASE_ANON_KEY) {
  if (rootEl) {
    rootEl.innerHTML = `
      <div class="config-error-banner" role="alert">
        خطأ: ملف الإعدادات config.js مفقود أو لا يحتوي على مفاتيح Supabase الصحيحة.
        يرجى التأكد من تحميل config.js قبل app.js.
      </div>
    `;
  }
  throw new Error("Missing window.INFOCC_CONFIG");
}

// 2. SUPABASE CLIENT
const { createClient } = window.supabase || {};
if (!createClient) {
  if (rootEl) {
    rootEl.innerHTML = `<div class="config-error-banner">خطأ: مكتبة Supabase لم يتم تحميلها بشكل صحيح.</div>`;
  }
  throw new Error("Missing Supabase library");
}

// Password-recovery detection: must run BEFORE createClient, because Supabase
// clears the URL hash right after reading the tokens from it.
let recoveryMode = /type=recovery/.test(location.hash) || /type=recovery/.test(location.search);

const supabase = createClient(
  window.INFOCC_CONFIG.SUPABASE_URL,
  window.INFOCC_CONFIG.SUPABASE_ANON_KEY
);

// 3. APPLICATION STATE
const state = {
  session: null,
  user: null,
  role: "student", // "owner" | "uploader" | "student" (read-only from database)
  uploaderGroup: null, // 1..10 if uploader
  studentGroup: null, // read-only from the database (student_profiles)
  studentDisplayName: null,
  currentRoute: "#/",
  redirectAfterLogin: null,
  filesCache: [],
  teacherInfoCache: [], // Cache for teacher_info table
  renderedUserId: null,
  sidebarOpen: false,
  searchQuery: "",
  activePdfDoc: null,
  pdfCurrentPage: 1,
  pdfTotalPages: 1,
  pdfScale: 1.0,
  pdfCanvas: null,
  pdfContext: null
};

// Subject Normalization Helper for legacy free-text rows
const SUBJECT_DEFINITIONS = window.SUBJECTS || [
  { id: "algo", nameFr: "Algo & SDS 1", nameAr: "الخوارزميات وهياكل المعطيات 1" },
  { id: "arch", nameFr: "Comp Arch 1", nameAr: "بنية الحاسوب 1" },
  { id: "sys", nameFr: "Operating Sys 1", nameAr: "نظام التشغيل 1" },
  { id: "analyse", nameFr: "Math Analysis 1", nameAr: "التحليل الرياضي 1" },
  { id: "algebre", nameFr: "Algebra 1", nameAr: "الجبر 1" },
  { id: "elec", nameFr: "Fundamental Electronics", nameAr: "الإلكترونيك الأساسية" },
  { id: "histoire", nameFr: "History of Algeria", nameAr: "تاريخ الجزائر" }
];

function normalizeSubjectId(sub) {
  if (!sub) return "autre";
  const str = String(sub).trim().toLowerCase();
  for (const s of SUBJECT_DEFINITIONS) {
    if (s.id.toLowerCase() === str) return s.id;
    if (s.aliases && s.aliases.some(a => a.toLowerCase() === str)) return s.id;
    if (s.nameFr.toLowerCase().includes(str) || str.includes(s.id)) return s.id;
    if ((s.nameEn || s.nameFr || s.nameAr).includes(str)) return s.id;
  }
  if (str.includes("algo") || str.includes("sds")) return "algo";
  if (str.includes("arch")) return "arch";
  if (str.includes("sys") || str.includes("os") || str.includes("système")) return "sys";
  if (str.includes("anal") || str.includes("math")) return "analyse";
  if (str.includes("alg") || str.includes("جبر")) return "algebre";
  if (str.includes("elec") || str.includes("إلكترو")) return "elec";
  if (str.includes("hist") || str.includes("تاريخ")) return "histoire";
  return "autre";
}

function getSubjectObj(id) {
  return SUBJECT_DEFINITIONS.find(s => s.id === id) || {
    id: id || "autre",
    nameFr: id === "autre" ? "Other" : id,
    nameEn: id === "autre" ? "Other" : id,
    nameAr: id === "autre" ? "أخرى / عام" : id
  };
}

// Repair common UTF-8 text that was accidentally decoded as Windows-1252/Latin-1.
// This fixes legacy notification titles such as "Ø¥Ø¹Ù„Ø§Ù† ..." at display time
// without modifying the stored database values.
function repairMojibake(value) {
  if (value === null || value === undefined) return "";
  const input = String(value);
  if (!/[ÃØÙÐ][\u0080-\u00ff]|[ØÙ][\u0080-\u00ff]|Ø|Ù/.test(input)) return input;
  const cp1252 = {0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F};
  try {
    const bytes = [];
    for (const ch of input) {
      const cp = ch.codePointAt(0);
      if (cp <= 255) bytes.push(cp);
      else if (cp1252[cp] !== undefined) bytes.push(cp1252[cp]);
      else return input;
    }
    const fixed = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return /[\u0600-\u06FF]/.test(fixed) && !/[�]/.test(fixed) ? fixed : input;
  } catch (_) { return input; }
}

// XSS Sanitizer
function escapeHtml(str) {
  str = repairMojibake(str);
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 4. TEACHER INFO OVERRIDE RESOLUTION
function getResolvedTeacher(kind, subjectId, groupNo) {
  // Teachers live ONLY in the teacher_info table (managed by owner/admin).
  // "cours" rows are stored with group_no = NULL; td/tp rows with group_no 1..10.
  const gNo = kind === "cours" ? null : parseInt(groupNo, 10);
  const match = state.teacherInfoCache.find(
    t => t.kind === kind && t.subject_id === subjectId && (t.group_no ?? null) === gNo
  );

  if (match && match.name) {
    return { name: match.name, email: match.email || null, isCustom: true };
  }
  return { name: null, email: null, isCustom: false };
}

// Render teacher display with mailto when email exists
function teacherSlug(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "teacher";
}

function renderTeacherDisplayHtml(resolvedTeacher, kind = "cours", subjectId = "", groupNo = 0) {
  const validName = !!(resolvedTeacher && resolvedTeacher.name);
  const nameHtml = validName
    ? `<a href="#/teacher/${encodeURIComponent(teacherSlug(resolvedTeacher.name))}" class="teacher-profile-link" title="عرض صفحة الأستاذ وملفاته">${escapeHtml(resolvedTeacher.name)}</a>`
    : `<span style="color: var(--muted); font-size: 13px;">لم يُعيّن بعد</span>`;
  const emailHtml = resolvedTeacher?.email
    ? `<a href="mailto:${escapeHtml(resolvedTeacher.email)}" title="مراسلة الأستاذ" class="mono" style="font-size: 12px; text-decoration: underline;" dir="ltr">${escapeHtml(resolvedTeacher.email)}</a>`
    : "";
  const profileButton = validName
    ? `<a href="#/teacher/${encodeURIComponent(teacherSlug(resolvedTeacher.name))}" class="btn-secondary" style="padding:2px 8px;font-size:11px;text-decoration:none;">ملفات الأستاذ</a>`
    : "";
  return `<div style="display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap;">${nameHtml}${emailHtml}${profileButton}</div>`;
}

// 5. AUTH & ROLE INITIALIZATION
async function fetchRoleAndGroup() {
  state.studentDisplayName = null;
  try {
    const { data, error } = await supabase.rpc("my_role");
    if (error) {
      console.warn("RPC my_role error:", error);
      state.role = "student";
      state.uploaderGroup = null;
      state.studentGroup = null;
      if (error.message && !error.message.includes("Failed to fetch")) {
        showGlobalError(`خطأ في التحقق من الرتبة: ${error.message}`);
      }
      return;
    }
    // Read authoritative role, uploader_group, and assigned_group from DB
    if (Array.isArray(data) && data.length > 0) {
      state.role = data[0]?.user_role || "student";
      state.uploaderGroup = data[0]?.uploader_group ?? null;
      state.studentGroup = state.role === "student" ? (data[0]?.assigned_group ?? null) : null;
    } else if (typeof data === "object" && data !== null) {
      state.role = data.user_role || "student";
      state.uploaderGroup = data.uploader_group ?? null;
      state.studentGroup = state.role === "student" ? (data.assigned_group ?? null) : null;
    } else if (typeof data === "string") {
      state.role = data;
      state.uploaderGroup = null;
      state.studentGroup = null;
    } else {
      state.role = "student";
      state.uploaderGroup = null;
      state.studentGroup = null;
    }
    // Read the student's own profile after the role RPC. The SQL onboarding
    // function is the only writer for a newly confirmed student's group/name.
    if (state.role === "student" && state.user?.id) {
      const { data: profile, error: profileError } = await supabase
        .from("student_profiles")
        .select("group_no, display_name")
        .eq("user_id", state.user.id)
        .maybeSingle();
      if (!profileError && profile) {
        const g = Number(profile.group_no);
        state.studentGroup = g >= 1 && g <= 10 ? g : null;
        state.studentDisplayName = profile.display_name ? String(profile.display_name) : null;
      } else {
        // Keep the authoritative assigned_group returned by my_role() when the
        // profile read is temporarily blocked by RLS/network/cache issues.
        const rpcGroup = Number(state.studentGroup);
        state.studentGroup = Number.isInteger(rpcGroup) && rpcGroup >= 1 && rpcGroup <= 10 ? rpcGroup : null;
        state.studentDisplayName = null;
        if (profileError) console.warn("student_profiles read failed; using my_role assigned_group fallback:", profileError);
      }
    }
  } catch (err) {
    console.warn("Network or execution error in my_role:", err);
    state.role = "student";
    state.uploaderGroup = null;
    state.studentGroup = null;
  }
}

function showGlobalError(msg) {
  const existing = document.getElementById("globalErrorNotification");
  if (existing) existing.remove();
  const box = document.createElement("div");
  box.id = "globalErrorNotification";
  box.className = "auth-error-box";
  box.style.cssText = "position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 9999; display: block; max-width: 90%;";
  box.textContent = msg;
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 6000);
}

// Router Guard: hashes not starting with #/ are ignored
function normalizeHash(hash) {
  if (!hash || !hash.startsWith("#/")) return "#/";
  return hash;
}

// 6. SUPABASE AUTH LISTENER
supabase.auth.onAuthStateChange((event, session) => {
  setTimeout(async () => {
    state.session = session;
    state.user = session?.user || null;

    if (event === "PASSWORD_RECOVERY") recoveryMode = true;

    // While the user is choosing a new password, never switch to the app.
    // (Supabase fires SIGNED_IN right before/after PASSWORD_RECOVERY.)
    if (recoveryMode) {
      if (!document.getElementById("pwResetForm")) renderPasswordRecoveryScreen();
      return;
    }

    if (state.user) {
      // Token refreshes and profile updates must not rebuild the page
      // (it would wipe whatever the user is typing).
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      if (event === "SIGNED_IN" && state.renderedUserId === state.user.id) return;

      await fetchRoleAndGroup();
      if (state.role === "student" && !state.studentGroup) {
        state.renderedUserId = state.user.id;
        renderStudentOnboarding();
        return;
      }
      await Promise.all([loadFilesCache(), loadTeacherInfoCache()]);
      state.renderedUserId = state.user.id;

      const target = state.redirectAfterLogin || normalizeHash(location.hash);
      state.redirectAfterLogin = null;
      location.hash = target;
      renderApp();
    } else {
      // Logged out
      state.renderedUserId = null;
      state.role = "student";
      state.uploaderGroup = null;
      state.studentGroup = null;
      state.studentDisplayName = null;
      state.filesCache = [];
      state.teacherInfoCache = [];
      location.hash = "#/";
      renderLoggedOut();
    }
  }, 0);
});

// Cache files
async function loadFilesCache() {
  try {
    const { data, error } = await supabase
      .from("files")
      .select("*")
      .order("created_at", { ascending: false });
    if (!error && data) {
      state.filesCache = data;
    } else {
      state.filesCache = [];
    }
  } catch (e) {
    console.error("Error loading files cache:", e);
    state.filesCache = [];
  }
}

// Cache teacher_info table
async function loadTeacherInfoCache() {
  try {
    const { data, error } = await supabase
      .from("teacher_info")
      .select("*");
    if (!error && data) {
      state.teacherInfoCache = data;
    } else {
      state.teacherInfoCache = [];
    }
  } catch (e) {
    console.error("Error loading teacher_info cache:", e);
    state.teacherInfoCache = [];
  }
}

// Friendly Arabic messages for common Supabase auth errors
function translateAuthError(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("invalid login credentials")) return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
  if (m.includes("email not confirmed")) return "لم يتم تأكيد البريد الإلكتروني بعد. افتح رسالة التأكيد في بريدك.";
  if (m.includes("already registered") || m.includes("already been registered")) return "هذا البريد مسجل من قبل. جرّب تسجيل الدخول أو استرجاع كلمة المرور.";
  if (m.includes("rate limit") || m.includes("too many") || m.includes("security purposes")) return "محاولات كثيرة في وقت قصير. استنى دقيقة وعاود المحاولة.";
  if (m.includes("same password") || m.includes("different from the old")) return "كلمة المرور الجديدة لازم تكون مختلفة عن القديمة.";
  if (m.includes("at least") && m.includes("character")) return "كلمة المرور قصيرة، استعمل 6 أحرف على الأقل.";
  if (m.includes("failed to fetch") || m.includes("network")) return "مشكل في الاتصال بالإنترنت. عاود المحاولة.";
  if (m.includes("invalid email") || m.includes("unable to validate email")) return "صيغة البريد الإلكتروني غير صحيحة.";
  return msg;
}

// ============================================================================
// 6.5 LOGIN SELECTION-ZOOM EFFECT
// اضغط بالزر الأيمن واسحب لرسم مربع أزرق؛ عند الإفلات تكبر بطاقة الدخول /
// إنشاء الحساب كاملة وتستقر مكان المربع. Esc أو زر ✕ أو نقرة يمنى قصيرة = رجوع.
// ============================================================================
let loginZoomRect = null;        // last selection (kept across re-renders)
let loginZoomEscBound = false;

function initLoginSelectZoom() {
  const page = rootEl.querySelector(".login-page");
  const wrapper = rootEl.querySelector(".auth-wrapper");
  const card = rootEl.querySelector(".auth-card");
  if (!page || !wrapper || !card) return;

  const MIN_DRAG = 40;     // px: smaller than this counts as a simple click
  const MAX_SCALE = 2.4;   // never blow the card up more than this
  const MARGIN = 10;       // keep the card away from the screen edges

  // Reset button (shown only while zoomed)
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "zoom-reset";
  closeBtn.setAttribute("aria-label", "إرجاع الحجم الأصلي");
  closeBtn.textContent = "✕";
  card.appendChild(closeBtn);

  // Small hint, only for devices that have a real mouse
  const hint = document.createElement("p");
  hint.className = "zoom-hint";
  hint.textContent = "نصيحة: اضغط بالزر الأيمن واسحب لتكبير نافذة الدخول";
  wrapper.appendChild(hint);

  function place(rect, animate) {
    card.style.transition = animate ? "" : "none";
    card.style.transform = "none";
    void card.offsetWidth; // force reflow so we measure the untransformed box
    const base = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;

    let s = Math.min(rect.width / base.width, rect.height / base.height);
    s = Math.max(1, Math.min(s, MAX_SCALE));
    s = Math.min(s, (vw - 2 * MARGIN) / base.width, (vh - 2 * MARGIN) / base.height);
    s = Math.max(s, 0.5);

    const w = base.width * s, h = base.height * s;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top + rect.height / 2 - h / 2;
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - w - MARGIN));
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - h - MARGIN));

    card.classList.add("zoomed");
    page.classList.add("has-zoom");
    card.style.transform = `translate(${left - base.left}px, ${top - base.top}px) scale(${s})`;
    if (!animate) { void card.offsetWidth; card.style.transition = ""; }
  }

  function reset() {
    loginZoomRect = null;
    card.classList.remove("zoomed");
    page.classList.remove("has-zoom");
    card.style.transform = "";
  }

  closeBtn.addEventListener("click", reset);

  // --- drawing the blue selection box ------------------------------------
  let box = null, startX = 0, startY = 0, dragging = false, moved = false;

  function rectFrom(x1, y1, x2, y2) {
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    return { left, top, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }
  function isTextField(el) {
    return !!(el && el.closest && el.closest("input, textarea, select"));
  }

  function onMove(e) {
    if (!dragging) return;
    const r = rectFrom(startX, startY, e.clientX, e.clientY);
    if (!moved && (r.width > 6 || r.height > 6)) {
      moved = true;
      box = document.createElement("div");
      box.className = "selection-box";
      document.body.appendChild(box);
      page.classList.add("selecting");
    }
    if (box) {
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
    }
  }

  function endDrag(e, cancelled) {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    page.classList.remove("selecting");
    const r = rectFrom(startX, startY, e.clientX, e.clientY);
    if (box) { box.remove(); box = null; }
    if (cancelled) return;
    if (moved && r.width >= MIN_DRAG && r.height >= MIN_DRAG) {
      loginZoomRect = r;
      place(r, true);
    } else if (!moved && card.classList.contains("zoomed")) {
      reset(); // short right-click on the page while zoomed = go back
    }
  }
  function onUp(e) { if (e.button === 2) endDrag(e, false); }
  function onCancel(e) { endDrag(e, true); }

  page.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 2) return;
    if (isTextField(e.target)) return; // keep the normal menu (paste, etc.) on inputs
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  });

  // Hide the browser menu on the login page (except on input fields)
  page.addEventListener("contextmenu", (e) => {
    if (!isTextField(e.target)) e.preventDefault();
  });

  // Keep the card correct when the window or the card height changes
  // (e.g. switching to the sign-up tab makes the card taller).
  const refit = () => { if (loginZoomRect && card.classList.contains("zoomed")) place(loginZoomRect, false); };
  window.addEventListener("resize", refit);
  if (window.ResizeObserver) new ResizeObserver(refit).observe(card);

  if (!loginZoomEscBound) {
    loginZoomEscBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const z = rootEl.querySelector(".auth-card.zoomed");
      if (z) { loginZoomRect = null; z.classList.remove("zoomed"); z.style.transform = ""; rootEl.querySelector(".login-page")?.classList.remove("has-zoom"); }
    });
  }

  // Re-apply the previous selection after a re-render (e.g. wrong password)
  if (loginZoomRect) place(loginZoomRect, false);
}

// 7. LOGGED-OUT VIEW RENDERER
function renderLoggedOut(errorMessage = "", successMessage = "") {
  rootEl.innerHTML = `
    <div class="auth-container login-page">
      <div class="auth-wrapper">
        <div class="auth-panel-banner">
          <div class="logo-badge mono">info_cc_404</div>
          <h1>info cc 404</h1>
          <p>منصة طلبة الإعلام الآلي — 10 أفواج / 7 مواد</p>
        </div>

        <div class="auth-card">
          <div class="auth-tabs" role="tablist">
            <button type="button" class="auth-tab active" id="tabLoginBtn">تسجيل الدخول</button>
            <button type="button" class="auth-tab" id="tabSignupBtn">إنشاء حساب</button>
          </div>

          <div id="authAlertError" class="auth-error-box" style="${errorMessage ? 'display:block' : ''}">
            ${escapeHtml(errorMessage)}
          </div>
          <div id="authAlertSuccess" class="auth-success-box" style="${successMessage ? 'display:block' : ''}">
            ${escapeHtml(successMessage)}
          </div>

          <!-- LOGIN FORM: NO group select -->
          <form id="authLoginForm" autocomplete="off">
            <div class="form-group">
              <label class="form-label" for="loginEmail">البريد الإلكتروني</label>
              <input type="email" id="loginEmail" class="form-control" placeholder="name@univ.dz" required autocomplete="off">
            </div>

            <div class="form-group">
              <label class="form-label" for="loginPass">كلمة المرور</label>
              <input type="password" id="loginPass" class="form-control" placeholder="••••••••" required>
            </div>

            <button type="submit" class="btn-primary" id="loginSubmitBtn" style="margin-top: 10px;">
              دخول
            </button>

            <div style="text-align: center; margin-top: 14px;">
              <a href="#" id="forgotPassLink" style="font-size: 13px; color: var(--muted);">نسيت كلمة المرور؟</a>
            </div>
          </form>

          <!-- SIGNUP FORM: REQUIRED group select -->
          <form id="authSignupForm" style="display: none;" autocomplete="off">
            <div class="form-group">
              <label class="form-label" for="signupEmail">البريد الإلكتروني</label>
              <input type="email" id="signupEmail" class="form-control" placeholder="name@univ.dz" required>
            </div>

            <div class="form-group">
              <label class="form-label" for="signupPass">كلمة المرور</label>
              <input type="password" id="signupPass" class="form-control" placeholder="6 أحرف على الأقل" required minlength="6">
            </div>

            <p class="auth-help-note">بعد تأكيد بريدك الإلكتروني، ستظهر لك صفحة لاختيار اسم المستخدم والفوج الدراسي.</p>

            <button type="submit" class="btn-primary" id="signupSubmitBtn" style="margin-top: 10px;">
              إنشاء الحساب
            </button>
          </form>

          <div id="forgotPassBox" style="display: none; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line);">
            <div style="font-size: 13px; font-weight: 500; margin-bottom: 8px;">استرجاع كلمة المرور</div>
            <div class="form-group">
              <input type="email" id="forgotEmail" class="form-control" placeholder="البريد الإلكتروني لتلقي رابط إعادة التعيين">
            </div>
            <button type="button" class="btn-secondary" id="sendResetBtn" style="width: 100%;">
              إرسال رابط التعيين
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const tabLogin = document.getElementById("tabLoginBtn");
  const tabSignup = document.getElementById("tabSignupBtn");
  const loginForm = document.getElementById("authLoginForm");
  const signupForm = document.getElementById("authSignupForm");
  const forgotBox = document.getElementById("forgotPassBox");

  tabLogin.onclick = () => {
    tabLogin.classList.add("active");
    tabSignup.classList.remove("active");
    loginForm.style.display = "block";
    signupForm.style.display = "none";
    forgotBox.style.display = "none";
  };

  tabSignup.onclick = () => {
    tabSignup.classList.add("active");
    tabLogin.classList.remove("active");
    loginForm.style.display = "none";
    signupForm.style.display = "block";
    forgotBox.style.display = "none";
  };

  document.getElementById("forgotPassLink").onclick = (e) => {
    e.preventDefault();
    forgotBox.style.display = forgotBox.style.display === "none" ? "block" : "none";
  };

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const pass = document.getElementById("loginPass").value;
    const btn = document.getElementById("loginSubmitBtn");
    btn.disabled = true;
    btn.textContent = "جاري الدخول...";

    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) {
      renderLoggedOut(translateAuthError(error.message));
    }
  };

  signupForm.onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("signupEmail").value.trim();
    const pass = document.getElementById("signupPass").value;
    const btn = document.getElementById("signupSubmitBtn");
    btn.disabled = true;
    btn.textContent = "جاري الإنشاء...";

    // Supabase sends signup confirmation separately from password-reset emails.
    // The redirect must also be allow-listed in Supabase Authentication > URL Configuration.
    const emailRedirectTo = `${window.location.origin}${window.location.pathname}`;
    const { data, error } = await supabase.auth.signUp({
      email,
      password: pass,
      options: {
        emailRedirectTo,
        data: {}
      }
    });

    if (error) {
      renderLoggedOut(translateAuthError(error.message));
    } else if (data?.user && !data?.session) {
      // Email confirmation is ON: the user must confirm before logging in.
      renderLoggedOut("", "تم إنشاء الحساب. افتح رسالة التأكيد في بريدك. بعد الضغط على الرابط ستظهر لك صفحة اختيار اسم المستخدم والفوج، ولن تحتاج إلى تسجيل الدخول مرة أخرى.");
    }
    // else: a session exists -> the auth listener opens the app by itself.
  };

  document.getElementById("sendResetBtn").onclick = async () => {
    const email = document.getElementById("forgotEmail").value.trim();
    if (!email) {
      alert("يرجى كتابة البريد الإلكتروني");
      return;
    }
    const redirectUrl = window.location.origin + window.location.pathname;
    const sendBtn = document.getElementById("sendResetBtn");
    sendBtn.disabled = true;
    sendBtn.textContent = "جاري الإرسال...";
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl
    });
    if (error) {
      renderLoggedOut(translateAuthError(error.message));
    } else {
      renderLoggedOut("", "تم إرسال رابط إعادة التعيين إلى بريدك الإلكتروني.");
    }
  };

  initLoginSelectZoom();
}


// 7.5 STUDENT PROFILE SETUP — shown after the email confirmation link signs in.
function renderStudentOnboarding() {
  const userEmail = state.user?.email || "";
  rootEl.innerHTML = `
    <div class="auth-container onboarding-page">
      <div class="auth-wrapper">
        <div class="auth-panel-banner">
          <div class="logo-badge mono">info_cc_404</div>
          <h1>أكمل إعداد حسابك</h1>
          <p>خطوة واحدة قبل دخول منصة طلبة الإعلام الآلي</p>
        </div>
        <div class="auth-card onboarding-card">
          <div class="onboarding-email" dir="ltr">${escapeHtml(userEmail)}</div>
          <form id="studentOnboardingForm">
            <div class="form-group">
              <label class="form-label" for="studentDisplayName">اسم المستخدم</label>
              <input id="studentDisplayName" class="form-control" type="text" minlength="2" maxlength="40"
                autocomplete="nickname" placeholder="اكتب الاسم الذي تريد أن يظهر للطلاب" required>
              <small class="auth-help-note">هذا الاسم سيظهر داخل الموقع بدل اسم بريدك الإلكتروني.</small>
            </div>
            <div class="form-group">
              <label class="form-label" for="studentGroupChoice">الفوج الدراسي</label>
              <select id="studentGroupChoice" class="form-control mono" required ${state.studentGroup ? "disabled" : ""}>
                <option value="" disabled ${state.studentGroup ? "" : "selected"}>اختر فوجك</option>
                ${Array.from({length:10},(_,i)=>`<option value="${i+1}" ${Number(state.studentGroup) === i+1 ? "selected" : ""}>G${i+1}</option>`).join("")}
              </select>
              ${state.studentGroup ? `<small class="auth-help-note">الفوج G${state.studentGroup} محفوظ مسبقًا في حسابك ولا يمكن تغييره من هذه الصفحة.</small>` : ""}
            </div>
            <div id="onboardingError" class="auth-error-box" role="alert" style="display:none;"></div>
            <button class="btn-primary" id="saveStudentProfileBtn" type="submit">حفظ ومتابعة إلى الموقع</button>
          </form>
        </div>
      </div>
    </div>`;
  const form = document.getElementById("studentOnboardingForm");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const name = document.getElementById("studentDisplayName").value.trim().replace(/\s+/g," ");
    const group = Number(document.getElementById("studentGroupChoice").value);
    const errorBox = document.getElementById("onboardingError");
    const btn = document.getElementById("saveStudentProfileBtn");
    if (name.length < 2 || name.length > 40 || !Number.isInteger(group) || group < 1 || group > 10) {
      errorBox.textContent = "يرجى إدخال اسم من حرفين إلى 40 حرفًا واختيار فوج صحيح.";
      errorBox.style.display = "block";
      return;
    }
    btn.disabled = true;
    btn.textContent = "جارٍ حفظ بياناتك...";
    errorBox.style.display = "none";
    const { error } = await supabase.rpc("complete_student_profile", {
      p_display_name: name,
      p_group_no: group
    });
    if (error) {
      errorBox.textContent = "تعذر حفظ بياناتك: " + translateAuthError(error.message);
      errorBox.style.display = "block";
      btn.disabled = false;
      btn.textContent = "حفظ ومتابعة إلى الموقع";
      return;
    }
    state.studentGroup = group;
    state.studentDisplayName = name;
    await fetchRoleAndGroup();
    await Promise.all([loadFilesCache(), loadTeacherInfoCache()]);
    state.renderedUserId = state.user?.id || null;
    location.hash = "#/";
    renderApp();
  };
}

// 8. PASSWORD RECOVERY SCREEN
function renderPasswordRecoveryScreen() {
  rootEl.innerHTML = `
    <div class="auth-container">
      <div class="auth-wrapper">
        <div class="auth-panel-banner">
          <div class="logo-badge mono">info_cc_404</div>
          <h1>info cc 404</h1>
          <p>إعادة تعيين كلمة المرور</p>
        </div>

        <div class="auth-card">
          <h2 style="font-size: 18px; margin-bottom: 12px; font-weight: 600;">كلمة سر جديدة</h2>
          <div id="pwResetAlert" class="auth-error-box"></div>
          <form id="pwResetForm">
            <div class="form-group">
              <label class="form-label" for="newPassword">كلمة المرور الجديدة</label>
              <input type="password" id="newPassword" class="form-control" placeholder="••••••••" required minlength="6">
            </div>
            <button type="submit" class="btn-primary" id="updatePwBtn">حفظ كلمة المرور</button>
          </form>
        </div>
      </div>
    </div>
  `;

  document.getElementById("pwResetForm").onsubmit = async (e) => {
    e.preventDefault();
    const newPass = document.getElementById("newPassword").value;
    const btn = document.getElementById("updatePwBtn");
    btn.disabled = true;
    btn.textContent = "جاري الحفظ...";

    const { error } = await supabase.auth.updateUser({ password: newPass });
    if (error) {
      const alertBox = document.getElementById("pwResetAlert");
      alertBox.textContent = translateAuthError(error.message);
      alertBox.style.display = "block";
      btn.disabled = false;
      btn.textContent = "حفظ كلمة المرور";
    } else {
      recoveryMode = false;
      alert("تم تحديث كلمة المرور بنجاح!");
      location.hash = "#/";
      await fetchRoleAndGroup();
      await Promise.all([loadFilesCache(), loadTeacherInfoCache()]);
      state.renderedUserId = state.user ? state.user.id : null;
      renderApp();
    }
  };
}

// 9. LOGGED-IN APP SHELL & ROUTER
function startBinaryRain() {
  // Draw a very light, static binary texture. The previous continuously
  // animated canvas repainted thousands of glyphs every frame and competed
  // with page rendering on lower-powered devices.
  const host = document.getElementById("app");
  if (!host) return;
  let canvas = document.getElementById("binaryRainCanvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "binaryRainCanvas";
    canvas.setAttribute("aria-hidden", "true");
    host.prepend(canvas);
  }
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;
  const drawStatic = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1);
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "12px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(126, 91, 59, .075)";
    for (let x = 18; x < width; x += 48) {
      for (let y = 24; y < height; y += 52) {
        ctx.fillText(((Math.floor(x / 48) + Math.floor(y / 52)) % 2) ? "1" : "0", x, y);
      }
    }
  };
  if (state._binaryRainResize) window.removeEventListener("resize", state._binaryRainResize);
  state._binaryRainResize = drawStatic;
  window.addEventListener("resize", drawStatic, { passive: true });
  drawStatic();
  if (state._binaryRainFrame) {
    cancelAnimationFrame(state._binaryRainFrame);
    state._binaryRainFrame = null;
  }
}
function renderApp() {
  if (recoveryMode) {
    if (!document.getElementById("pwResetForm")) renderPasswordRecoveryScreen();
    return;
  }
  if (!state.user) {
    renderLoggedOut();
    return;
  }

  if (state.role === "suspended") {
    rootEl.innerHTML = `
      <div style="min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--cream,#fbf7f0);">
        <div class="content-card" style="max-width:560px;text-align:center;padding:28px;">
          <h2 style="color:var(--brown-dark);margin-bottom:10px;">تم إيقاف هذا الحساب</h2>
          <p style="color:var(--muted);line-height:1.9;">تم إيقاف الوصول إلى المنصة من قبل المالك. إذا كنت تعتقد أن هذا الإجراء حدث بالخطأ، تواصل مع إدارة المنصة.</p>
          <button type="button" class="btn-primary" id="suspendedLogoutBtn" style="width:auto;margin:16px auto 0;">تسجيل الخروج</button>
        </div>
      </div>`;
    document.getElementById("suspendedLogoutBtn").onclick = async () => {
      await supabase.auth.signOut();
      state.session = null;
      state.user = null;
      state.role = "student";
      state.uploaderGroup = null;
      state.studentGroup = null;
      state.studentDisplayName = null;
      state.filesCache = [];
      state.teacherInfoCache = [];
      state.renderedUserId = null;
      renderLoggedOut("تم تسجيل الخروج بنجاح.");
    };
    return;
  }

  const hash = normalizeHash(location.hash);
  state.currentRoute = hash;

  const isOwner = state.role === "owner";
  const isAdmin = state.role === "admin";
  const isUploader = state.role === "uploader";

  // Build shell — Figma dashboard structure, preserving existing event hooks and routes.
  rootEl.innerHTML = `
    <div class="app-container figma-app-shell">
      <div id="sidebarBackdrop" class="sidebar-backdrop"></div>
      <aside id="appSidebar" class="app-sidebar figma-sidebar">
        <div class="sidebar-header figma-brand">
          <span class="sidebar-cap-icon" aria-hidden="true"><bdi>404</bdi></span>
          <span class="sidebar-brand-name"><bdi>info cc 404</bdi><small>مساحة طلبة الإعلام الآلي</small></span>
        </div>
        <nav class="sidebar-nav figma-nav" aria-label="القائمة الرئيسية">
          <div class="figma-nav-caption">مساحة التعلم</div>
          <a href="#/" class="nav-link ${hash === "#/" ? "active" : ""}"><span class="nav-icon-box">⌂</span><span>الرئيسية</span></a>
          <a href="#/search" class="nav-link ${hash === "#/search" ? "active" : ""}"><span class="nav-icon-box">▤</span><span>مكتبتي وملفاتي</span></a>
          <a href="#/groupes" class="nav-link ${hash.startsWith("#/groupe") || hash === "#/groupes" ? "active" : ""}"><span class="nav-icon-box">▣</span><span>الدروس والمحاضرات</span></a>
          <a href="#/teachers" class="nav-link ${hash.startsWith("#/teacher") ? "active" : ""}"><span class="nav-icon-box">♧</span><span>الأساتذة</span></a>
          <a href="#/horaire" class="nav-link ${hash === "#/horaire" ? "active" : ""}"><span class="nav-icon-box">▦</span><span>الجدول الدراسي</span></a>
          <a href="#/exams" class="nav-link ${hash === "#/exams" ? "active" : ""}"><span class="nav-icon-box">▧</span><span>أرشيف الامتحانات</span></a>
          <a href="#/quizzes" class="nav-link ${hash === "#/quizzes" ? "active" : ""}"><span class="nav-icon-box">✓</span><span>اختبارات QCM</span></a>
          <a href="#/notes" class="nav-link ${hash === "#/notes" ? "active" : ""}"><span class="nav-icon-box">✎</span><span>ملاحظاتي الدراسية</span></a>
          <a href="#/study-plan" class="nav-link ${hash === "#/study-plan" ? "active" : ""}"><span class="nav-icon-box">◷</span><span>مخطط المراجعة</span></a>
          <a href="#/discussions" class="nav-link ${hash === "#/discussions" ? "active" : ""}"><span class="nav-icon-box">◎</span><span>مساحة الأسئلة</span></a>
          <a href="#/announcements" class="nav-link ${hash === "#/announcements" ? "active" : ""}"><span class="nav-icon-box">♢</span><span>الإعلانات</span></a>
          <a href="#/notifications" class="nav-link ${hash === "#/notifications" ? "active" : ""}"><span class="nav-icon-box">♧</span><span>الإشعارات</span><span class="nav-notification-dot" id="sidebarNotificationUnread" hidden></span></a>
          <a href="#/messages" class="nav-link ${hash === "#/messages" ? "active" : ""}"><span class="nav-icon-box">☏</span><span>المراسلات والشات</span></a>
          ${(isOwner || isAdmin || isUploader) ? `
            <div class="figma-nav-caption figma-nav-caption-spaced">إدارة المنصة</div>
            <a href="#/upload" class="nav-link ${hash === "#/upload" ? "active" : ""}"><span class="nav-icon-box">＋</span><span>رفع الملفات</span></a>
            ${(isOwner || isAdmin) ? `<a href="#/admin" class="nav-link ${hash === "#/admin" ? "active" : ""}"><span class="nav-icon-box">⚙</span><span>إدارة الملفات</span></a>` : ""}
            ${isOwner ? `<a href="#/owner-users" class="nav-link ${hash === "#/owner-users" ? "active" : ""}"><span class="nav-icon-box">♙</span><span>إدارة المستخدمين</span></a><a href="#/owner-insights" class="nav-link ${hash === "#/owner-insights" ? "active" : ""}"><span class="nav-icon-box">▥</span><span>إحصائيات المالك</span></a>` : ""}
          ` : ""}
          <div class="figma-nav-caption figma-nav-caption-spaced">حسابك</div>
          <a href="#/compte" class="nav-link ${hash === "#/compte" ? "active" : ""}"><span class="nav-icon-box">♙</span><span>حسابي</span></a>
          <a href="#/preferences" class="nav-link ${hash === "#/preferences" ? "active" : ""}"><span class="nav-icon-box">⚙</span><span>تفضيلات الواجهة</span></a>
          <a href="#/support" class="nav-link ${hash === "#/support" ? "active" : ""}"><span class="nav-icon-box">?</span><span>الإبلاغ عن مشكلة</span></a>
        </nav>
        <div class="figma-sidebar-profile">
          <div class="figma-profile-avatar" id="sidebarProfileAvatar">${escapeHtml((state.studentDisplayName || state.user.email)?.[0]?.toUpperCase() || "ط")}</div>
          <div class="figma-profile-copy"><strong>${escapeHtml(state.studentDisplayName || state.user.email?.split("@")[0] || "مستخدم")}</strong><small>${state.role === "owner" ? "المالك · جميع الأفواج" : state.role === "admin" ? "مشرف المنصة" : state.role === "uploader" ? `رئيس القسم · G${state.uploaderGroup || "—"}` : (state.studentGroup ? `طالب · G${state.studentGroup}` : "مساحة الطالب")}</small></div>
        </div>
        <div class="figma-sidebar-note"><strong>مساحة هادئة للدراسة</strong><span>ملفاتك وملاحظاتك وخطتك، كلها في مكان واحد.</span></div>
        <div class="sidebar-footer"><button type="button" class="btn-secondary" id="sidebarLogoutBtn">تسجيل الخروج</button></div>
        <div class="figma-sidebar-copy">INFO CC 404 · ${new Date().getFullYear()}</div>
      </aside>
      <div class="app-main figma-main">
        <header class="app-topbar figma-topbar">
          <div class="figma-breadcrumb">مساحة الطالب <span>/</span> <strong>${hash === "#/" ? "الرئيسية" : "مساحة التعلم"}</strong></div>
          <button type="button" id="mobileMenuBtn" class="mobile-menu-btn" aria-label="فتح القائمة">☰</button>
          <div class="search-box-wrapper figma-search">
            <input type="text" id="topSearchInput" class="search-input" placeholder="ابحث عن مادة، ملف، أو أستاذ...">
            <span class="figma-search-symbol">⌕</span>
            <div id="searchResultsDropdown" class="search-results-dropdown"></div>
          </div>
          <div class="topbar-right-info figma-topbar-actions">
            <button type="button" id="notificationBellBtn" class="notification-bell" aria-label="الإشعارات" title="الإشعارات">
              <svg class="bell-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span id="notificationUnreadCount" style="display:none;position:absolute;top:-6px;left:-6px;background:#a33b2f;color:white;border-radius:20px;min-width:18px;height:18px;padding:0 4px;font-size:11px;line-height:18px;text-align:center;"></span>
            </button>
            <button type="button" id="themeToggleBtn" class="figma-theme-toggle" aria-label="تبديل الوضع الليلي" title="تبديل الوضع الليلي">◐</button>
            <div class="figma-topbar-user"><span class="figma-topbar-greeting">مرحباً بعودتك</span><span class="user-avatar-circle" id="topbarAvatar" title="${escapeHtml(state.studentDisplayName || state.user.email)}">${escapeHtml((state.studentDisplayName || state.user.email)?.[0]?.toUpperCase() || "U")}</span><span class="role-badge ${state.role}">${getRoleBadgeText(state.role, state.uploaderGroup)}</span></div>
          </div>
        </header>
        <main class="page-body figma-page-body" id="pageContent"></main>
      </div>
    </div>
  `;

  attachShellEvents();
  dispatchRoute(hash);
  updateSidebarActiveRoute(hash);
  startBinaryRain();
}

// Owner and admin are the only roles that manage teachers and the timetable.
function canManageContent() {
  return state.role === "owner" || state.role === "admin";
}

function getRoleBadgeText(role, uploaderGroup) {
  if (role === "owner") return "المالك";
  if (role === "admin") return "مشرف";
  if (role === "uploader") return `رئيس القسم (G${uploaderGroup || ""})`;
  return "طالب";
}

// owner_list_users has existed with two column naming conventions in deployed
// databases. Normalize both to avoid empty administrator/head tables.
function listedUserRole(user) {
  return user?.role ?? user?.user_role ?? user?.current_role ?? "student";
}
function listedUserGroup(user) {
  return user?.group_no ?? user?.uploader_group ?? user?.signup_group ?? null;
}
function listedUserId(user) {
  return user?.id ?? user?.user_id ?? null;
}

function applyThemePreference(theme) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  try { localStorage.setItem("info-cc-404-theme", selected); } catch (_) {}
  const button = document.getElementById("themeToggleBtn");
  if (button) {
    button.textContent = selected === "dark" ? "الوضع الفاتح" : "الوضع الليلي";
    button.setAttribute("aria-pressed", selected === "dark" ? "true" : "false");
  }
}

function attachShellEvents() {
  const savedTheme = (() => { try { return localStorage.getItem("info-cc-404-theme") || "light"; } catch (_) { return "light"; } })();
  applyThemePreference(savedTheme);
  if (state.user?.id) {
    supabase.from("user_preferences").select("theme,font_scale,compact_mode").eq("user_id", state.user.id).maybeSingle().then(({data}) => {
      if (!data) return;
      const preferred = data.theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : data.theme;
      applyThemePreference(preferred);
      document.documentElement.style.setProperty("--user-font-scale", String(data.font_scale || 1));
      document.documentElement.classList.toggle("compact-mode", !!data.compact_mode);
    }).catch(() => {});
  }
  const themeButton = document.getElementById("themeToggleBtn");
  if (themeButton) themeButton.onclick = async () => { const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; applyThemePreference(next); if (state.user?.id) { const {error} = await supabase.from("user_preferences").upsert({user_id:state.user.id,theme:next,updated_at:new Date().toISOString()},{onConflict:"user_id"}); if (error) console.warn("Could not sync theme preference", error.message); } };
  const sidebar = document.getElementById("appSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const menuBtn = document.getElementById("mobileMenuBtn");
  const logoutBtn = document.getElementById("sidebarLogoutBtn");
  const avatar = document.getElementById("topbarAvatar");
  const notificationBell = document.getElementById("notificationBellBtn");
  const searchInput = document.getElementById("topSearchInput");
  const searchDropdown = document.getElementById("searchResultsDropdown");

  const toggleSidebar = () => {
    state.sidebarOpen = !state.sidebarOpen;
    sidebar.classList.toggle("open", state.sidebarOpen);
    backdrop.classList.toggle("open", state.sidebarOpen);
  };

  if (menuBtn) menuBtn.onclick = toggleSidebar;
  if (backdrop) backdrop.onclick = toggleSidebar;

  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      await supabase.auth.signOut();
      state.session = null;
      state.user = null;
      state.role = "student";
      state.uploaderGroup = null;
      state.filesCache = [];
      state.teacherInfoCache = [];
      state.renderedUserId = null;
      location.hash = "#/";
      renderLoggedOut("تم تسجيل الخروج بنجاح.");
    };
  }

  if (avatar) {
    avatar.onclick = () => { location.hash = "#/compte"; };
  }
  if (notificationBell) {
    notificationBell.onclick = () => { location.hash = "#/notifications"; };
    refreshNotificationBadge();
  }

  // Live Search in readable files
  if (searchInput && searchDropdown) {
    searchInput.oninput = () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        searchDropdown.style.display = "none";
        searchDropdown.innerHTML = "";
        return;
      }
      const accessible = getAccessibleFiles();
      const results = accessible.filter(f => (f.title || "").toLowerCase().includes(q));
      if (results.length === 0) {
        searchDropdown.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--muted); font-size: 13px;">لا توجد ملفات مطابقة</div>`;
      } else {
        searchDropdown.innerHTML = results.slice(0, 10).map(f => `
          <div class="search-result-item" data-id="${f.id}">
            <div>
              <div style="font-weight: 500; font-size: 13px;">${escapeHtml(f.title)}</div>
              <div style="font-size: 11px; color: var(--muted);" class="mono">${escapeHtml(f.subject)} · ${f.kind} ${f.group_no ? `· G${f.group_no}` : "· كل الأفواج"}</div>
            </div>
            <span class="badge-tag">عرض</span>
          </div>
        `).join("");

        searchDropdown.querySelectorAll(".search-result-item").forEach(item => {
          item.onclick = () => {
            const fileId = item.getAttribute("data-id");
            searchDropdown.style.display = "none";
            searchInput.value = "";
            location.hash = `#/voir/${fileId}`;
          };
        });
      }
      searchDropdown.style.display = "block";
    };

    if (state._searchOutsideClick) document.removeEventListener("click", state._searchOutsideClick);
    state._searchOutsideClick = (e) => {
      if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
        searchDropdown.style.display = "none";
      }
    };
    document.addEventListener("click", state._searchOutsideClick);
  }
}

// 10. File scope helpers. The database group assignment is authoritative;
// when legacy rows have a NULL group_no, infer a group only from a trusted gN/ storage path.
const SCHEDULE_PDF_SUBJECT = "__schedule_pdf__";

function isScheduleProgramFile(file) {
  return String(file?.subject || "") === SCHEDULE_PDF_SUBJECT;
}

function getFileGroupNo(file) {
  const explicit = Number(file?.group_no);
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 10) return explicit;
  const path = String(file?.path || "");
  const match = path.match(/^g(10|[1-9])\//);
  return match ? Number(match[1]) : null;
}

function isSharedFile(file) {
  const path = String(file?.path || "");
  return file?.group_no == null && path.startsWith("common/");
}

// 10. FILTER ACCESSIBLE FILES FOR THE USER
function getAccessibleFiles() {
  if (state.role === "owner" || state.role === "admin") return state.filesCache;
  const group = state.role === "uploader" ? state.uploaderGroup : state.studentGroup;
  return state.filesCache.filter(file => {
    // Course lectures are shared content; other legacy rows without a group are
    // not automatically shared unless stored under common/.
    // A course file is shared only when explicitly stored under common/.
    // NULL group_no on a legacy/root path is ambiguous and must not expose it to every group.
    if (file.kind === "cours" && isSharedFile(file)) return true;
    const fileGroup = getFileGroupNo(file);
    if (fileGroup != null) return Number(group) === fileGroup;
    return isSharedFile(file);
  });
}

function isFileForGroup(file, groupNo) {
  const fileGroup = getFileGroupNo(file);
  if (fileGroup != null) return fileGroup === Number(groupNo);
  return isSharedFile(file);
}

// Move a file to another group (or to "all groups"): the storage object and the
// database row are changed together; if the database update fails the move is undone.
async function moveFileToGroup(file, targetGroup) {
  const oldPath = String(file.path || "");
  const baseName = oldPath.split("/").pop();
  const newPath = `${targetGroup ? `g${targetGroup}` : "common"}/${baseName}`;

  if (newPath !== oldPath) {
    const { error: moveErr } = await supabase.storage.from("course-files").move(oldPath, newPath);
    if (moveErr) throw new Error(moveErr.message);
  }

  const { error: dbErr } = await supabase
    .from("files")
    .update({ group_no: targetGroup, path: newPath })
    .eq("id", file.id);

  if (dbErr) {
    if (newPath !== oldPath) {
      await supabase.storage.from("course-files").move(newPath, oldPath);
    }
    throw new Error(dbErr.message);
  }
}

// 11. ROUTE DISPATCHER
// Internal notifications. Requires migration_notifications_adminlog.sql to be applied once.
async function loadMyNotifications() {
  if (!state.user?.id) return [];
  const { data, error } = await supabase.from("user_notifications")
    .select("id,title,body,kind,link,created_at,read_at")
    .eq("user_id", state.user.id).order("created_at", { ascending: false }).limit(100);
  if (error) { console.warn("Notifications are unavailable; apply migration_notifications_adminlog.sql", error.message); return null; }
  return (data || []).map(n => ({ ...n, title: repairMojibake(n.title), body: repairMojibake(n.body), link: n.link || "#/" }));
}
async function refreshNotificationBadge() {
  const badge = document.getElementById("notificationUnreadCount");
  const sideDot = document.getElementById("sidebarNotificationUnread");
  if (!state.user?.id) return;
  const { count, error } = await supabase.from("user_notifications").select("id", { count: "exact", head: true }).eq("user_id", state.user.id).is("read_at", null);
  if (error) { if (badge) badge.style.display = "none"; if (sideDot) sideDot.hidden = true; return; }
  if (badge) { badge.textContent = count > 99 ? "99+" : String(count || 0); badge.style.display = count > 0 ? "inline-block" : "none"; }
  if (sideDot) sideDot.hidden = !(count > 0);
}
async function renderNotificationsView(page) {
  page.innerHTML = `<div class="page-banner"><h2>الإشعارات</h2><p>تابع آخر التنبيهات والتحديثات الخاصة بحسابك.</p></div>
    <section class="content-card"><div class="notifications-toolbar"><h3>آخر الإشعارات</h3><div class="notifications-actions"><button type="button" id="markAllNotificationsRead" class="btn-secondary">تحديد الكل كمقروء</button><button type="button" id="deleteSelectedNotifications" class="btn-danger-soft" disabled>حذف المحدد</button></div></div><p class="notifications-help">ضع علامة بجانب الإشعار الذي تريد حذفه، ثم اضغط «حذف المحدد».</p><div id="notificationsList" class="notifications-list"><p>جارٍ تحميل الإشعارات...</p></div></section>`;
  const listEl = page.querySelector("#notificationsList");
  const items = await loadMyNotifications();
  if (items === null) { listEl.innerHTML = `<p style="line-height:1.9">لم يتم العثور على جدول الإشعارات أو لا تسمح الصلاحيات بقراءته. تأكد من تطبيق <code>migration_notifications_adminlog.sql</code> في مشروع Supabase الصحيح.</p>`; page.querySelector("#markAllNotificationsRead").disabled = true; page.querySelector("#deleteSelectedNotifications").disabled = true; return; }
  listEl.innerHTML = items.length ? items.map(n => `<article class="notification-item ${n.read_at ? 'is-read' : 'is-unread'}"><label class="notification-select" title="تحديد الإشعار للحذف"><input type="checkbox" class="notification-select-check" value="${escapeHtml(n.id)}" aria-label="تحديد الإشعار ${escapeHtml(n.title || '')}"><span></span></label><div class="notification-content"><div class="notification-heading"><strong>${escapeHtml(n.title || 'إشعار')}</strong>${n.read_at ? '' : '<span class="notification-new">جديد</span>'}</div><p class="notification-body">${escapeHtml(n.body || '')}</p><div class="notification-footer"><small>${escapeHtml(n.created_at ? new Date(n.created_at).toLocaleString('ar') : '')}</small><div class="notification-row-actions">${n.link ? `<button class="btn-secondary notification-open" data-id="${escapeHtml(n.id)}" data-link="${escapeHtml(n.link)}">فتح</button>` : ''}${n.read_at ? '' : `<button class="btn-secondary notification-read" data-id="${escapeHtml(n.id)}">تحديد كمقروء</button>`}</div></div></div></article>`).join("") : `<p class="empty-state">لا توجد إشعارات حتى الآن.</p>`;
  const deleteBtn = page.querySelector("#deleteSelectedNotifications");
  const checkboxes = [...page.querySelectorAll(".notification-select-check")];
  const updateDeleteState = () => { deleteBtn.disabled = !checkboxes.some(c => c.checked); };
  checkboxes.forEach(c => c.addEventListener("change", updateDeleteState));
  deleteBtn.onclick = async () => {
    const ids = checkboxes.filter(c => c.checked).map(c => c.value);
    if (!ids.length) return;
    if (!confirm(`هل تريد حذف ${ids.length} من الإشعارات المحددة؟`)) return;
    deleteBtn.disabled = true; deleteBtn.textContent = "جارٍ الحذف...";
    const { error } = await supabase.from("user_notifications").delete().in("id", ids).eq("user_id", state.user.id);
    if (error) { alert("تعذر حذف الإشعارات. تأكد من تطبيق تحديث صلاحيات الحذف الموجود في ملف migration_notifications_adminlog.sql."); deleteBtn.textContent = "حذف المحدد"; updateDeleteState(); return; }
    await renderNotificationsView(page); await refreshNotificationBadge();
  };
  page.querySelectorAll(".notification-read").forEach(btn => btn.addEventListener("click", async () => {
    const { error } = await supabase.from("user_notifications").update({ read_at: new Date().toISOString() }).eq("id", btn.dataset.id).eq("user_id", state.user.id);
    if (error) { alert("تعذر تحديث الإشعار. تحقق من سياسات جدول user_notifications في Supabase."); return; }
    await renderNotificationsView(page); await refreshNotificationBadge();
  }));
  page.querySelectorAll(".notification-open").forEach(btn => btn.addEventListener("click", async () => {
    await supabase.from("user_notifications").update({ read_at: new Date().toISOString() }).eq("id", btn.dataset.id).eq("user_id", state.user.id);
    const link = btn.dataset.link || "#/";
    if (link.startsWith("#/")) location.hash = link;
    else if (link === "announcements") location.hash = "#/announcements";
    else location.hash = "#/";
  }));
  page.querySelector("#markAllNotificationsRead").onclick = async () => {
    const { error } = await supabase.from("user_notifications").update({ read_at: new Date().toISOString() }).eq("user_id", state.user.id).is("read_at", null);
    if (error) { alert("تعذر تحديث الإشعارات."); return; }
    await renderNotificationsView(page); await refreshNotificationBadge();
  };
  refreshNotificationBadge();
}

function dispatchRoute(hash) {
  const page = document.getElementById("pageContent");
  if (!page) return;

  // #/
  if (hash === "#/") {
    renderHomeView(page);
    return;
  }

  // #/announcements
  if (hash === "#/announcements") { renderAnnouncementsView(page); return; }
  if (hash === "#/notifications") { renderNotificationsView(page); return; }
  if (hash === "#/search") { renderSearchPage(page); return; }
  if (hash === "#/exams") { renderExamsArchiveView(page); return; }
  if (hash === "#/quizzes") { renderLearningFeaturePage(page, "quizzes"); return; }
  if (hash === "#/polls") { renderLearningFeaturePage(page, "polls"); return; }
  if (hash === "#/discussions") { renderLearningFeaturePage(page, "discussions"); return; }
  if (hash === "#/notes") { renderLearningFeaturePage(page, "notes"); return; }
  if (hash === "#/study-plan") { renderLearningFeaturePage(page, "planner"); return; }
  if (hash === "#/progress") { renderLearningFeaturePage(page, "progress"); return; }
  if (hash === "#/owner-insights") { renderLearningFeaturePage(page, "insights"); return; }
  if (hash === "#/preferences") { renderLearningFeaturePage(page, "preferences"); return; }
  const quizAttemptMatch = hash.match(/^#\/quiz\/([0-9a-f-]+)$/i);
  if (quizAttemptMatch) { renderQuizAttemptPage(page, quizAttemptMatch[1]); return; }
  if (hash === "#/favorites") { renderFavoritesPage(page); return; }
  if (hash === "#/support") { renderSupportPage(page); return; }
  if (hash === "#/messages") { renderStudentMessagesView(page); return; }

  // #/groupes
  if (hash === "#/groupes") {
    renderGroupesView(page);
    return;
  }

  // #/groupe/N or #/groupe/N/<tab> or #/groupe/N/<tab>/<subjectId>
  const groupMatch = hash.match(/^#\/groupe\/(\d+)(?:\/([^\/]+)(?:\/([^\/]+))?)?$/);
  if (groupMatch) {
    const groupNo = parseInt(groupMatch[1], 10);
    const tab = groupMatch[2] || "cours";
    const subjectId = groupMatch[3] || null;
    renderGroupDetailView(page, groupNo, tab, subjectId);
    return;
  }

  // #/horaire
  if (hash === "#/horaire") {
    renderTimetableView(page);
    return;
  }

  // #/teachers and filtered teacher directories
  const teachersMatch = hash.match(/^#\/teachers(?:\/(cours|td|tp))?$/);
  if (teachersMatch) {
    renderTeachersView(page, teachersMatch[1] || "all");
    return;
  }

  // #/teacher/:slug
  const teacherMatch = hash.match(/^#\/teacher\/([^/]+)$/);
  if (teacherMatch) {
    renderTeacherProfileView(page, decodeURIComponent(teacherMatch[1]));
    return;
  }

  // #/voir/:id
  const viewMatch = hash.match(/^#\/voir\/([^\/]+)$/);
  if (viewMatch) {
    const fileId = viewMatch[1];
    renderPdfViewerView(page, fileId);
    return;
  }

  // #/upload (owner, admin and uploader)
  if (hash === "#/upload") {
    if (state.role !== "owner" && state.role !== "admin" && state.role !== "uploader") {
      renderAccessDenied(page);
      return;
    }
    renderUploadView(page);
    return;
  }

  // #/owner-users — owner-only user directory and account suspension controls
  if (hash === "#/owner-users") {
    if (state.role !== "owner") {
      renderAccessDenied(page);
      return;
    }
    renderOwnerUsersView(page);
    return;
  }

  // #/admin (owner and admin)
  if (hash === "#/admin") {
    if (state.role !== "owner") {
      renderAccessDenied(page);
      return;
    }
    renderAdminView(page);
    return;
  }

  // #/compte
  if (hash === "#/compte") {
    renderAccountView(page);
    return;
  }

  // Unknown route: 404
  renderNotFoundView(page);
}

// Exam archive reuses the existing files table and private Storage bucket.
// Access is always filtered through getAccessibleFiles(), preserving group RLS.
function renderExamsArchiveView(page) {
  const allExams = getAccessibleFiles().filter(file => String(file.kind || "").toLowerCase() === "exam");
  const subjects = [...new Set(allExams.map(file => normalizeSubjectId(file.subject)).filter(Boolean))].sort();
  const semesters = [...new Set(allExams.map(file => String(file.semester || "").trim()).filter(Boolean))].sort();
  const canFilterGroups = state.role === "owner" || state.role === "admin";
  page.innerHTML = `
    <div class="page-banner">
      <h2>أرشيف الامتحانات السابقة</h2>
      <p>اجمع امتحانات السنوات السابقة في مكان واحد، وابحث حسب المادة والفصل الدراسي. تظهر لك الملفات التي تسمح صلاحيات حسابك بالوصول إليها فقط.</p>
    </div>
    <section class="content-card">
      <div class="exam-archive-filters" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px;">
        <label class="form-group">بحث في العناوين
          <input id="examArchiveSearch" class="form-control" type="search" placeholder="اكتب اسم الامتحان أو كلمة منه">
        </label>
        <label class="form-group">المادة
          <select id="examArchiveSubject" class="form-control">
            <option value="">كل المواد</option>
            ${subjects.map(id => { const sub = getSubjectObj(id); return `<option value="${escapeHtml(id)}">${escapeHtml(sub.nameEn || sub.nameFr || id)}</option>`; }).join("")}
          </select>
        </label>
        <label class="form-group">الفصل الدراسي
          <select id="examArchiveSemester" class="form-control">
            <option value="">كل الفصول</option>
            ${semesters.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}
          </select>
        </label>
        ${canFilterGroups ? `<label class="form-group">الفوج
          <select id="examArchiveGroup" class="form-control">
            <option value="">كل الأفواج</option>
            ${[1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}">G${g}</option>`).join("")}
          </select>
        </label>` : ""}
      </div>
      <div id="examArchiveCount" style="font-size:13px;color:var(--muted);margin-bottom:12px;"></div>
      <div id="examArchiveList" class="exam-archive-list"></div>
    </section>`;
  const search = page.querySelector("#examArchiveSearch");
  const subject = page.querySelector("#examArchiveSubject");
  const semester = page.querySelector("#examArchiveSemester");
  const group = page.querySelector("#examArchiveGroup");
  const list = page.querySelector("#examArchiveList");
  const count = page.querySelector("#examArchiveCount");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const selectedSubject = subject.value;
    const selectedSemester = semester.value;
    const selectedGroup = group?.value || "";
    const filtered = allExams.filter(file => {
      const title = String(file.title || "").toLowerCase();
      const sid = normalizeSubjectId(file.subject);
      return (!q || title.includes(q) || String(file.subject || "").toLowerCase().includes(q))
        && (!selectedSubject || sid === selectedSubject)
        && (!selectedSemester || String(file.semester || "") === selectedSemester)
        && (!selectedGroup || Number(file.group_no || 0) === Number(selectedGroup));
    }).sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    count.textContent = `عدد الامتحانات المتاحة: ${filtered.length}`;
    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">لا توجد امتحانات مطابقة حاليًا. ستظهر هنا الملفات التي تُرفع بنوع Exam والمتاحة لفوجك.</div>`;
      return;
    }
    list.innerHTML = filtered.map(file => {
      const sub = getSubjectObj(normalizeSubjectId(file.subject));
      const groupLabel = file.group_no ? `G${Number(file.group_no)}` : "مشترك";
      const dateLabel = file.created_at ? new Date(file.created_at).toLocaleDateString("ar") : "";
      return `<article class="content-card exam-archive-card" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 10px;padding:14px;">
        <div style="min-width:0;flex:1;">
          <strong style="display:block;color:var(--brown-dark);margin-bottom:5px;overflow-wrap:anywhere;">${escapeHtml(file.title || "امتحان دون عنوان")}</strong>
          <div style="display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px;">
            <span>${escapeHtml(sub.nameEn || sub.nameFr || file.subject || "—")}</span>
            <span>· ${escapeHtml(file.semester || "الفصل غير محدد")}</span>
            <span>· ${escapeHtml(groupLabel)}</span>
            ${dateLabel ? `<span>· أضيف في ${escapeHtml(dateLabel)}</span>` : ""}
          </div>
        </div>
        <a class="btn-primary" style="width:auto;text-decoration:none;white-space:nowrap;" href="#/voir/${encodeURIComponent(file.id)}">فتح الامتحان</a>
      </article>`;
    }).join("");
  };
  [search, subject, semester, group].filter(Boolean).forEach(el => el.addEventListener("input", draw));
  draw();
}

const ANNOUNCEMENT_PRIORITY = { urgent: 0, important: 1, normal: 2 };
function canManageAnnouncements() {
  return ["owner", "admin", "uploader"].includes(state.role);
}
async function loadAnnouncements() {
  try {
    const { data, error } = await supabase.from("announcements").select("*").order("created_at", { ascending: false });
    if (error) { console.warn("Announcements unavailable; apply migration_announcements.sql", error.message); return []; }
    return (data || []).sort((a,b) => (ANNOUNCEMENT_PRIORITY[a.priority] ?? 2) - (ANNOUNCEMENT_PRIORITY[b.priority] ?? 2) || new Date(b.created_at) - new Date(a.created_at));
  } catch (e) { console.warn("Could not load announcements", e); return []; }
}
function renderAnnouncementCard(a, manage=false) {
  const styles = { urgent: { label: "عاجل", bg: "#fff0ed", color: "#a33b2f", border: "#efb5aa" }, important: { label: "مهم", bg: "#fff5d9", color: "#815b12", border: "#ead18c" }, normal: { label: "عام", bg: "#f5eee4", color: "#72563b", border: "#e3d3bf" } };
  const st = styles[a.priority] || styles.normal;
  const date = a.created_at ? new Date(a.created_at).toLocaleDateString("ar") : "";
  return `<article style="background:#fff;border:1px solid ${st.border};border-right:4px solid ${st.color};border-radius:12px;padding:14px 16px;box-shadow:0 3px 12px #4b34200a;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:7px;"><strong style="color:var(--brown-dark);font-size:15px;">${escapeHtml(a.title || "إعلان")}</strong><span style="font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border-radius:20px;padding:4px 10px;">${st.label}</span></div>
    <p style="white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.9;color:#51483e;font-size:13px;margin:0 0 8px;">${escapeHtml(a.body || "")}</p>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;"><small style="color:var(--muted);">${escapeHtml(date)}${a.author_label ? " · "+escapeHtml(a.author_label) : ""}</small>${manage ? `<button type="button" class="btn-secondary announcement-delete" data-id="${escapeHtml(a.id)}" style="width:auto;padding:6px 10px;color:#a33b2f;">حذف</button>` : ""}</div>
  </article>`;
}
async function renderAnnouncementsView(page) {
  const canManage = canManageAnnouncements();
  page.innerHTML = `<div class="page-banner"><h2>الإعلانات</h2><p>إعلانات الدراسة والتنبيهات، مرتبة حسب الأهمية.</p></div>
    ${canManage ? `<section class="content-card" style="border:1px solid #e7d6bd;background:#fffdf8;"><h3 style="color:var(--brown-dark);margin-bottom:14px;">إضافة إعلان جديد</h3><form id="announcementForm" style="display:grid;gap:12px;"><label>عنوان الإعلان<input name="title" maxlength="140" required placeholder="مثال: تغيير موعد حصة" style="display:block;width:100%;margin-top:6px;"></label><label>تفاصيل الإعلان<textarea name="body" rows="4" maxlength="5000" required placeholder="اكتب تفاصيل الإعلان هنا..." style="display:block;width:100%;margin-top:6px;resize:vertical;"></textarea></label><label>الأهمية<select name="priority" style="display:block;width:100%;margin-top:6px;"><option value="normal">عادي</option><option value="important">مهم</option><option value="urgent">عاجل</option></select></label><button class="btn-primary" type="submit" style="width:auto;justify-self:start;">نشر الإعلان</button><p id="announcementFormMessage" style="margin:0;font-size:13px;"></p></form></section>` : ""}
    <section class="content-card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;"><h3 style="color:var(--brown-dark);margin:0;">قائمة الإعلانات</h3><span id="announcementCount" style="font-size:12px;color:var(--muted);"></span></div><div id="announcementsList" style="display:grid;gap:12px;"><p>جارٍ تحميل الإعلانات...</p></div></section>`;
  const list = await loadAnnouncements();
  const listEl = page.querySelector("#announcementsList");
  const countEl = page.querySelector("#announcementCount");
  if (!listEl) return;
  countEl.textContent = `${list.length} إعلان`;
  listEl.innerHTML = list.length ? list.map(a => renderAnnouncementCard(a, canManage)).join("") : '<p style="text-align:center;color:var(--muted);padding:20px;">لا توجد إعلانات منشورة حاليًا.</p>';
  if (canManage) {
    page.querySelector("#announcementForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget; const msg = page.querySelector("#announcementFormMessage");
      const fd = new FormData(form);
      const button = form.querySelector('button[type="submit"]'); button.disabled = true; msg.textContent = "جارٍ النشر...";
      const { error } = await supabase.from("announcements").insert({ title: String(fd.get("title")||"").trim(), body: String(fd.get("body")||"").trim(), priority: String(fd.get("priority")||"normal"), created_by: state.user.id, author_label: state.role === "owner" ? "إدارة المنصة" : state.role === "admin" ? "المشرف" : `رئيس القسم G${state.uploaderGroup || ""}` });
      button.disabled = false;
      if (error) { msg.textContent = "تعذر نشر الإعلان. تأكد من تطبيق migration_announcements.sql وصلاحيات Supabase."; msg.style.color = "#a33b2f"; console.error(error); return; }
      renderAnnouncementsView(page);
    });
    page.querySelectorAll(".announcement-delete").forEach(btn => btn.addEventListener("click", async () => {
      if (!confirm("هل تريد حذف هذا الإعلان؟")) return;
      const { error } = await supabase.from("announcements").delete().eq("id", btn.dataset.id);
      if (error) { alert("تعذر حذف الإعلان. تحقق من صلاحيات قاعدة البيانات."); return; }
      renderAnnouncementsView(page);
    }));
  }
}

// Student productivity tools: full-text file search, personal favorites, and support reports.
function renderSearchPage(page) {
  const files = getAccessibleFiles();
  page.innerHTML = `<div class="page-banner"><h2>البحث عن الملفات</h2><p>ابحث باسم الملف أو المادة أو الأستاذ، وستظهر الملفات المسموح لك بالوصول إليها فقط.</p></div>
    <section class="content-card"><label for="globalFileSearch" class="form-label">كلمات البحث</label><input id="globalFileSearch" class="form-control" type="search" placeholder="مثال: Analyse، TD، اسم الأستاذ..." autocomplete="off"><div class="filter-row" style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0"><select id="fileKindFilter" class="form-control" style="max-width:220px"><option value="">كل الأنواع</option><option value="cours">Cours</option><option value="td">TD</option><option value="tp">TP</option></select><span id="fileSearchCount" style="align-self:center;color:var(--muted);font-size:13px"></span></div><div id="fileSearchResults" class="search-results-grid"></div></section>`;
  const input=page.querySelector('#globalFileSearch'), kind=page.querySelector('#fileKindFilter'), results=page.querySelector('#fileSearchResults'), count=page.querySelector('#fileSearchCount');
  const draw=()=>{const q=input.value.trim().toLocaleLowerCase();const k=kind.value;const filtered=files.filter(f=>{const hay=[f.title,f.subject,f.kind,f.teacher_name,f.name].filter(Boolean).join(' ').toLocaleLowerCase();return (!q||hay.includes(q))&&(!k||String(f.kind).toLowerCase()===k)});count.textContent=`${filtered.length} نتيجة`;results.innerHTML=filtered.length?filtered.slice(0,100).map(f=>`<article class="content-card file-result-card"><strong>${escapeHtml(f.title||'ملف')}</strong><p>${escapeHtml(f.subject||'')} · ${escapeHtml(f.kind||'')} ${f.group_no?`· G${f.group_no}`:'· مشترك'}</p><a class="btn-primary" style="display:inline-block;width:auto;text-decoration:none" href="#/voir/${encodeURIComponent(f.id)}">فتح الملف</a> <button type="button" class="btn-secondary favorite-toggle" data-id="${escapeHtml(f.id)}">☆ حفظ في المفضلة</button></article>`).join(''):'<p class="empty-state">لا توجد ملفات مطابقة.</p>';results.querySelectorAll('.favorite-toggle').forEach(b=>b.onclick=()=>toggleFavorite(b.dataset.id,b));};
  input.addEventListener('input',draw);kind.addEventListener('change',draw);draw();
}
async function loadFavoriteIds(){const {data,error}=await supabase.from('student_favorites').select('file_id').eq('user_id',state.user.id);if(error){console.warn('Favorites unavailable; apply migration_student_tools.sql',error.message);return [];}return (data||[]).map(x=>String(x.file_id));}
async function toggleFavorite(fileId,button){const {data:existing,error:readError}=await supabase.from('student_favorites').select('file_id').eq('user_id',state.user.id).eq('file_id',String(fileId)).maybeSingle();if(readError){alert('تعذر قراءة المفضلة. تأكد من تطبيق migration_student_tools.sql.');return;}if(existing){const {error}=await supabase.from('student_favorites').delete().eq('user_id',state.user.id).eq('file_id',String(fileId));if(error){alert('تعذر حذف الملف من المفضلة.');return;}if(button)button.textContent='☆ حفظ في المفضلة';}else{const {error}=await supabase.from('student_favorites').insert({user_id:state.user.id,file_id:String(fileId)});if(error){alert('تعذر حفظ الملف في المفضلة. تأكد من تطبيق migration_student_tools.sql.');return;}if(button)button.textContent='★ محفوظ';}}
async function renderFavoritesPage(page){page.innerHTML='<div class="page-banner"><h2>ملفاتي المفضلة</h2><p>ملفات حفظتها للوصول إليها بسرعة.</p></div><section class="content-card" id="favoritesContent"><p>جارٍ تحميل المفضلة...</p></section>';const box=page.querySelector('#favoritesContent');const ids=await loadFavoriteIds();const accessible=getAccessibleFiles();const files=ids.map(id=>accessible.find(f=>String(f.id)===id)).filter(Boolean);box.innerHTML=files.length?`<div class="favorites-grid">${files.map(f=>`<article class="content-card"><strong>${escapeHtml(f.title||'ملف')}</strong><p>${escapeHtml(f.subject||'')} · ${escapeHtml(f.kind||'')}</p><a class="btn-primary" style="display:inline-block;width:auto;text-decoration:none" href="#/voir/${encodeURIComponent(f.id)}">فتح الملف</a><button class="btn-secondary remove-favorite" data-id="${escapeHtml(f.id)}" style="margin-inline-start:8px">إزالة</button></article>`).join('')}</div>`:'<p class="empty-state">لم تحفظ أي ملف بعد. استخدم زر «حفظ في المفضلة» في صفحة البحث.</p>';box.querySelectorAll('.remove-favorite').forEach(b=>b.onclick=async()=>{await toggleFavorite(b.dataset.id);renderFavoritesPage(page);});}
function renderSupportPage(page){const staff=['owner','admin'].includes(state.role);page.innerHTML=`<div class="page-banner"><h2>الإبلاغ عن مشكلة</h2><p>أخبرنا عن ملف لا يفتح أو فوج غير صحيح أو مشكلة تقنية.</p></div><section class="content-card"><form id="supportReportForm" style="display:grid;gap:14px;max-width:760px"><label class="form-label">نوع المشكلة<select class="form-control" name="category" required><option value="file">ملف لا يفتح أو عرضه غير سليم</option><option value="group">الفوج غير صحيح أو غير محفوظ</option><option value="account">مشكلة في الحساب أو الدخول</option><option value="other">مشكلة أخرى</option></select></label><label class="form-label">عنوان مختصر<input class="form-control" name="title" maxlength="140" required placeholder="اكتب عنوان المشكلة"></label><label class="form-label">التفاصيل<textarea class="form-control" name="details" rows="5" maxlength="3000" required placeholder="ما الذي حدث؟ وما الصفحة التي كنت تستخدمها؟"></textarea></label><button class="btn-primary" type="submit" style="width:auto;justify-self:start">إرسال البلاغ</button><p id="supportReportMessage" role="status"></p></form></section><section class="content-card" id="supportReportsAdmin" style="display:${staff?'block':'none'}"><h3 style="color:var(--brown-dark);margin-bottom:12px">بلاغات الطلبة</h3><div id="supportReportsList">جارٍ تحميل البلاغات...</div></section>`;page.querySelector('#supportReportForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,fd=new FormData(form),msg=page.querySelector('#supportReportMessage'),btn=form.querySelector('button');btn.disabled=true;msg.textContent='جارٍ إرسال البلاغ...';const {error}=await supabase.from('support_reports').insert({user_id:state.user.id,category:String(fd.get('category')),title:String(fd.get('title')).trim(),details:String(fd.get('details')).trim()});btn.disabled=false;if(error){msg.textContent='تعذر إرسال البلاغ. تأكد من تطبيق migration_student_tools.sql ثم أعد المحاولة.';msg.style.color='#a33b32';console.error(error);return;}form.reset();msg.textContent='تم إرسال البلاغ. شكرًا لمساعدتنا على تحسين الموقع.';msg.style.color='#28734a';};if(staff)loadSupportReports(page);}
async function loadSupportReports(page){const box=page.querySelector('#supportReportsList');if(!box)return;const {data,error}=await supabase.from('support_reports').select('id,user_id,category,title,details,status,created_at').order('created_at',{ascending:false}).limit(100);if(error){box.innerHTML='<p class="empty-state">تعذر تحميل البلاغات. تحقق من سياسات RLS في migration_student_tools.sql.</p>';console.warn(error);return;}const labels={file:'ملف',group:'فوج',account:'حساب',other:'أخرى',open:'مفتوح',in_progress:'قيد المعالجة',resolved:'تم الحل',closed:'مغلق'};box.innerHTML=data?.length?`<div class="support-report-list">${data.map(r=>`<article class="support-report-item"><div class="support-report-heading"><strong>${escapeHtml(r.title)}</strong><span class="badge-tag">${labels[r.category]||escapeHtml(r.category)}</span></div><p>${escapeHtml(r.details)}</p><small>${formatDate(r.created_at)} · ${labels[r.status]||escapeHtml(r.status)}</small><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><select class="form-control support-status" data-id="${escapeHtml(r.id)}" style="max-width:220px"><option value="open" ${r.status==='open'?'selected':''}>مفتوح</option><option value="in_progress" ${r.status==='in_progress'?'selected':''}>قيد المعالجة</option><option value="resolved" ${r.status==='resolved'?'selected':''}>تم الحل</option><option value="closed" ${r.status==='closed'?'selected':''}>مغلق</option></select><button type="button" class="btn-secondary save-support-status" data-id="${escapeHtml(r.id)}">حفظ الحالة</button></div></article>`).join('')}</div>`:'<p class="empty-state">لا توجد بلاغات بعد.</p>';box.querySelectorAll('.save-support-status').forEach(btn=>btn.onclick=async()=>{const select=box.querySelector(`.support-status[data-id="${btn.dataset.id}"]`);const status=select?.value;const {error}=await supabase.from('support_reports').update({status,...(['resolved','closed'].includes(status)?{resolved_at:new Date().toISOString()}:{resolved_at:null})}).eq('id',btn.dataset.id);if(error){alert('تعذر تحديث حالة البلاغ.');return;}btn.textContent='تم الحفظ';});}

function renderAccessDenied(page) {
  page.innerHTML = `
    <div class="content-card" style="text-align: center; padding: 40px;">
      <h2 style="font-size: 20px; font-weight: 600; color: var(--danger); margin-bottom: 8px;">ما عندكش الصلاحية</h2>
      <p style="color: var(--muted); margin-bottom: 20px;">هذه الصفحة مخصصة لمالك المنصة فقط.</p>
      <a href="#/" class="btn-primary" style="display: inline-block; width: auto;">العودة للرئيسية</a>
    </div>
  `;
}

// 11.5. Learning modules
const learningSubjects = [["algo","Algorithms & Data Structures"],["arch","Computer Architecture"],["sys","Operating Systems"],["analyse","Mathematical Analysis"],["algebre","Algebra"],["elec","Fundamental Electronics"],["histoire","History of Computing"],["discrete_math","Discrete Mathematics"],["prob_stats","Probability & Statistics"],["logic","Logic & Digital Systems"],["programming","Programming"],["databases","Databases"],["networks","Computer Networks"],["web","Web Development"],["physics","Physics"],["english","English"],["french","French"],["other","Other / Custom Subject"]];
function learningSubjectOptions(){return learningSubjects.map(x=>'<option value="'+x[0]+'">'+x[1]+'</option>').join("");}
function learningMsg(el,msg,bad){if(el)el.innerHTML='<div class="'+(bad?'auth-error-box':'auth-success-box')+'" style="display:block">'+escapeHtml(msg)+'</div>';}
async function renderLearningFeaturePage(page,kind){
  // Refresh the authenticated role before rendering privileged controls.
  // This prevents stale client-side role state from hiding quiz authoring.
  if(state.user?.id){
   const {data:roleData,error:roleError}=await supabase.rpc("my_role");
   if(!roleError&&roleData){
    const roleRow=Array.isArray(roleData)?roleData[0]:roleData;
    if(roleRow?.user_role){state.role=roleRow.user_role;state.uploaderGroup=roleRow.uploader_group??null;state.studentGroup=roleRow.assigned_group??state.studentGroup;}
   }
  }

 const titles={quizzes:"اختبارات QCM",discussions:"مساحة الأسئلة والأجوبة",notes:"ملاحظاتي الدراسية",planner:"مخطط المراجعة والامتحانات",progress:"لوحة تقدمي الدراسي",insights:"إحصائيات ومراقبة المنصة",preferences:"تخصيص الواجهة"};
 if(kind==="insights"&&state.role!=="owner"){page.innerHTML='<div class="content-card">هذه الصفحة متاحة للمالك فقط.</div>';return;}
 page.innerHTML='<div class="page-banner"><h2>'+titles[kind]+'</h2><p>أدوات دراسية منظمة وآمنة ضمن حسابك وصلاحيات فوجك.</p></div><div id="learnMsg"></div><div id="learnBody"><div class="content-card">جارٍ التحميل…</div></div>';
 const body=page.querySelector("#learnBody"),msg=page.querySelector("#learnMsg"),uid=state.user.id,staff=["owner","admin"].includes(state.role);
 const subj=id=>learningSubjects.find(x=>x[0]===id)?.[1]||id||"عام";
 if(kind==="notes"){
  const {data,error}=await supabase.from("student_notes").select("*").order("updated_at",{ascending:false});
  if(error){body.textContent="تعذر تحميل الملاحظات.";return;}
  body.innerHTML='<section class="content-card"><h3>ملاحظة جديدة</h3><form id="noteForm" class="learning-form"><input class="form-control" name="title" placeholder="العنوان" required maxlength="180"><select class="form-control" name="subject_id">'+learningSubjectOptions()+'</select><textarea class="form-control" name="body" rows="5" placeholder="اكتب ملخصك أو ملاحظاتك"></textarea><button class="btn-primary">حفظ الملاحظة</button></form></section><section class="content-card" style="margin-top:16px"><h3>ملاحظاتي</h3><div class="learning-list">'+(data||[]).map(n=>'<article class="learning-item"><div><strong>'+escapeHtml(n.title)+'</strong><p>'+escapeHtml(subj(n.subject_id))+'</p><div>'+escapeHtml(n.body)+'</div></div><button class="btn-secondary" data-del-note="'+n.id+'">حذف</button></article>').join("")+'</div></section>';
  body.querySelector("#noteForm").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const {error:err}=await supabase.from("student_notes").insert({user_id:uid,title:String(fd.get("title")).trim(),subject_id:fd.get("subject_id"),body:String(fd.get("body")||"")});if(err){learningMsg(msg,err.message,true);return;}await renderLearningFeaturePage(page,kind);};
  body.querySelectorAll("[data-del-note]").forEach(b=>b.onclick=async()=>{if(!confirm("حذف الملاحظة؟"))return;const {error:err}=await supabase.from("student_notes").delete().eq("id",b.dataset.delNote);if(err)learningMsg(msg,err.message,true);else await renderLearningFeaturePage(page,kind);});return;
 }
 if(kind==="planner"){
  const {data,error}=await supabase.from("study_plan_items").select("*").order("due_at",{ascending:true});
  if(error){body.textContent="تعذر تحميل المخطط.";return;}
  body.innerHTML='<section class="content-card"><h3>إضافة مهمة أو امتحان</h3><form id="planForm" class="learning-form"><input class="form-control" name="title" placeholder="العنوان" required><select class="form-control" name="subject_id">'+learningSubjectOptions()+'</select><select class="form-control" name="item_type"><option value="revision">مراجعة</option><option value="exam">امتحان</option><option value="assignment">واجب</option><option value="reading">قراءة درس</option><option value="other">أخرى</option></select><input class="form-control" name="due_at" type="datetime-local"><input class="form-control" name="estimated_minutes" type="number" min="5" max="1440" placeholder="المدة بالدقائق"><textarea class="form-control" name="notes" placeholder="ملاحظات"></textarea><button class="btn-primary">إضافة</button></form></section><section class="content-card" style="margin-top:16px"><h3>قائمة المهام</h3><div class="learning-list">'+(data||[]).map(it=>'<label class="learning-item"><span><strong>'+escapeHtml(it.title)+'</strong><small>'+escapeHtml(subj(it.subject_id))+' · '+(it.due_at?new Date(it.due_at).toLocaleString("ar"):"دون موعد")+'</small></span><input type="checkbox" data-plan="'+it.id+'" '+(it.is_completed?"checked":"")+'> مكتملة</label>').join("")+'</div></section>';
  body.querySelector("#planForm").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const {error:err}=await supabase.from("study_plan_items").insert({user_id:uid,title:String(fd.get("title")).trim(),subject_id:fd.get("subject_id"),item_type:fd.get("item_type"),due_at:fd.get("due_at")?new Date(fd.get("due_at")).toISOString():null,estimated_minutes:fd.get("estimated_minutes")?Number(fd.get("estimated_minutes")):null,notes:String(fd.get("notes")||"")});if(err){learningMsg(msg,err.message,true);return;}await renderLearningFeaturePage(page,kind);};
  body.querySelectorAll("[data-plan]").forEach(cb=>cb.onchange=async()=>{const {error:err}=await supabase.from("study_plan_items").update({is_completed:cb.checked,updated_at:new Date().toISOString()}).eq("id",cb.dataset.plan);if(err)learningMsg(msg,err.message,true);});return;
 }
 if(kind==="discussions"){
  const {data,error}=await supabase.from("discussion_questions").select("id,title,body,subject_id,group_no,created_at").order("created_at",{ascending:false}).limit(60);
  if(error){body.textContent="تعذر تحميل الأسئلة.";return;}
  body.innerHTML='<section class="content-card"><h3>طرح سؤال</h3><form id="askForm" class="learning-form"><input class="form-control" name="title" placeholder="عنوان السؤال" required><select class="form-control" name="subject_id">'+learningSubjectOptions()+'</select><select class="form-control" name="group_no">' +(staff?'<option value="">سؤال عام</option>'+[1,2,3,4,5,6,7,8,9,10].map(n=>'<option value="'+n+'">G'+n+'</option>').join(""):'<option value="'+(state.role==="uploader"?state.uploaderGroup:state.studentGroup)+'" selected>G'+(state.role==="uploader"?state.uploaderGroup:state.studentGroup)+'</option>') +'</select><textarea class="form-control" name="body" placeholder="اشرح سؤالك" required></textarea><button class="btn-primary">نشر</button></form></section><section class="content-card" style="margin-top:16px"><h3>الأسئلة الحديثة</h3><div class="learning-list">'+(data||[]).map(q=>'<article class="learning-item" style="display:block"><strong>'+escapeHtml(q.title)+'</strong><p>'+escapeHtml(subj(q.subject_id))+' · '+(q.group_no?"G"+q.group_no:"عام")+'</p><p>'+escapeHtml(q.body)+'</p><div id="ans-'+q.id+'"></div><form class="answer-form learning-form" data-q="'+q.id+'"><textarea class="form-control" name="body" placeholder="إجابتك" required></textarea><button class="btn-secondary">إرسال إجابة</button></form></article>').join("")+'</div></section>';
  body.querySelector("#askForm").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget),g=fd.get("group_no");const {error:err}=await supabase.from("discussion_questions").insert({author_id:uid,title:String(fd.get("title")).trim(),body:String(fd.get("body")).trim(),subject_id:fd.get("subject_id"),group_no:g?Number(g):null});if(err){learningMsg(msg,err.message,true);return;}await renderLearningFeaturePage(page,kind);};
  for(const q of data||[]){const {data:answers}=await supabase.from("discussion_answers").select("body,created_at").eq("question_id",q.id).order("created_at");const el=body.querySelector("#ans-"+q.id);if(el)el.innerHTML=(answers||[]).map(x=>'<div class="learning-answer">'+escapeHtml(x.body)+'</div>').join("")||'<small>لا توجد إجابات.</small>';}
  body.querySelectorAll(".answer-form").forEach(form=>form.onsubmit=async e=>{e.preventDefault();const {error:err}=await supabase.from("discussion_answers").insert({question_id:form.dataset.q,author_id:uid,body:String(new FormData(form).get("body")).trim()});if(err){learningMsg(msg,err.message,true);return;}await renderLearningFeaturePage(page,kind);});return;
 }
 if(kind==="polls"){
  await renderCoursePolls(body,uid,state.role,state.uploaderGroup,page);
  return;
 }
 if(kind==="quizzes"){
  const quizStaff=["owner","admin","uploader"].includes(state.role),isHead=state.role==="uploader",ownGroup=Number(state.uploaderGroup);
  const {data:quizzes,error}=await supabase.from("quizzes").select("id,title,description,subject_id,group_no,duration_minutes,is_published,deleted_at").is("deleted_at",null).order("created_at",{ascending:false});
  if(error){body.textContent="تعذر تحميل الاختبارات: "+escapeHtml(error.message);return;}
  const quizIds=(quizzes||[]).map(q=>q.id);
  let questions=[];
  if(quizStaff&&quizIds.length){
   const qr=await supabase.from("quiz_questions").select("id,quiz_id,prompt,position,deleted_at").in("quiz_id",quizIds).is("deleted_at",null).order("position",{ascending:true});
   if(qr.error){body.textContent="تعذر تحميل أسئلة الاختبارات: "+escapeHtml(qr.error.message);return;}
   questions=qr.data||[];
  }
  const groupField=isHead?'<input type="hidden" name="group_no" value="'+ownGroup+'"><p class="learning-hint">سيُنشر الاختبار لفوجك G'+ownGroup+' فقط.</p>':'<label class="form-label">الفوج المستهدف<select name="group_no" class="form-control"><option value="">كل الأفواج</option>'+[1,2,3,4,5,6,7,8,9,10].map(n=>'<option value="'+n+'">G'+n+'</option>').join("")+'</select></label>';
  const subjectField='<label class="form-label">المادة<select name="subject_id" class="form-control">'+learningSubjectOptions()+'</select></label><input name="custom_subject" class="form-control" maxlength="80" placeholder="اكتب اسم المادة" style="display:none" aria-label="اسم المادة المخصص">';
  const quizCards=(quizzes||[]).map(q=>{
   const qs=questions.filter(x=>x.quiz_id===q.id);
   const questionHtml=qs.length?qs.map(x=>'<div class="learning-item quiz-question-manage"><span><strong>'+escapeHtml(x.prompt)+'</strong><small>السؤال '+x.position+'</small></span><button type="button" class="btn-danger-soft" data-delete-question="'+x.id+'">حذف السؤال</button></div>').join(""):'<p class="learning-hint">لم تُضف أسئلة إلى هذا الاختبار بعد.</p>';
   return '<article class="learning-item quiz-manage-card"><div class="quiz-manage-main"><div><strong>'+escapeHtml(q.title)+'</strong><p>'+escapeHtml(subj(q.subject_id))+' · '+(q.group_no?"G"+q.group_no:"كل الأفواج")+' · '+(q.is_published?"منشور":"مخفي")+' · '+qs.length+' سؤال</p></div><div class="quiz-manage-actions"><a class="btn-primary" href="#/quiz/'+q.id+'">فتح</a>'+(quizStaff?'<button type="button" class="btn-danger-soft" data-delete-quiz="'+q.id+'">حذف الاختبار</button>':'')+'</div></div>'+(quizStaff?'<details class="quiz-question-management"><summary>إدارة أسئلة هذا الاختبار</summary><div class="learning-list">'+questionHtml+'</div></details>':'')+'</article>';
  }).join("");
  body.innerHTML=(quizStaff?'<section class="content-card"><h3>إنشاء اختبار QCM</h3><p class="learning-hint">يمكنك نشر الاختبار لكل الأفواج أو تخصيصه لفوج محدد. اختر المادة والمدة ثم أنشئ الاختبار.</p><form id="newQuiz" class="learning-form"><label class="form-label">عنوان الاختبار<input name="title" class="form-control" placeholder="مثال: اختبار الفصل الأول في Algorithms" required maxlength="180"></label><label class="form-label">وصف الاختبار<textarea name="description" class="form-control" placeholder="تعليمات أو وصف مختصر للاختبار"></textarea></label>'+subjectField+groupField+'<label class="form-label">مدة الاختبار بالدقائق<input name="duration_minutes" class="form-control" type="number" min="1" max="240" placeholder="اختياري"></label><button type="submit" class="btn-primary">إنشاء الاختبار</button></form></section>':'')+
  '<section class="content-card" style="margin-top:16px"><h3>الاختبارات المتاحة</h3><div class="learning-list">'+(quizCards||'<p class="empty-state">لا توجد اختبارات متاحة حاليًا.</p>')+'</div></section>'+
  (quizStaff&&quizzes?.length?'<section class="content-card" style="margin-top:16px"><h3>إضافة سؤال QCM</h3><p class="learning-hint">ابدأ بثلاثة خيارات، ويمكنك إضافة خيار رابع أو خامس أو حذف الخيارات الزائدة. يمكنك تحديد إجابة صحيحة واحدة أو عدة إجابات صحيحة.</p><form id="newQuestion" class="learning-form"><label class="form-label">الاختبار<select name="quiz_id" class="form-control">'+quizzes.map(q=>'<option value="'+q.id+'">'+escapeHtml(q.title)+'</option>').join("")+'</select></label><label class="form-label">نص السؤال<textarea name="prompt" class="form-control" rows="3" placeholder="اكتب السؤال بوضوح" required maxlength="3000"></textarea></label><div class="quiz-options-editor"><div class="quiz-options-editor-heading"><strong>خيارات الإجابة</strong><span id="quizOptionCount">3 من 5</span></div><div id="quizOptionsEditor">'+[0,1,2].map(i=>'<div class="quiz-option-editor-row"><label class="form-label"><span>الخيار '+String.fromCharCode(65+i)+'</span><input class="form-control" name="option_text" maxlength="1000" required placeholder="اكتب نص الخيار '+String.fromCharCode(65+i)+'"></label><button type="button" class="btn-danger-soft" data-remove-option aria-label="حذف الخيار">حذف</button></div>').join("")+'</div><button type="button" id="addQuizOption" class="btn-secondary">+ إضافة خيار</button></div><fieldset class="quiz-correct-options"><legend>الإجابات الصحيحة</legend><p class="learning-hint">حدد خيارًا واحدًا أو عدة خيارات صحيحة.</p><div id="quizCorrectOptions" class="quiz-correct-options-list"><label><input type="checkbox" name="correct_position" value="0" checked> A</label><label><input type="checkbox" name="correct_position" value="1"> B</label><label><input type="checkbox" name="correct_position" value="2"> C</label></div></fieldset><button type="submit" class="btn-primary">حفظ السؤال والتصحيح</button></form></section>':'');
  const qf=body.querySelector("#newQuestion");
  if(qf){
   const optionsWrap=qf.querySelector("#quizOptionsEditor"),addOption=qf.querySelector("#addQuizOption"),correctWrap=qf.querySelector("#quizCorrectOptions"),optionCount=qf.querySelector("#quizOptionCount");
   const syncOptionEditor=()=>{
    const rows=[...optionsWrap.querySelectorAll(".quiz-option-editor-row")];
    rows.forEach((row,i)=>{row.querySelector("span").textContent="الخيار "+String.fromCharCode(65+i);row.querySelector("input").placeholder="اكتب نص الخيار "+String.fromCharCode(65+i);row.querySelector("[data-remove-option]").disabled=rows.length<=3;});
    const selected=[...correctWrap.querySelectorAll('input[name="correct_position"]:checked')].map(x=>x.value);
    correctWrap.innerHTML=rows.map((row,i)=>'<label><input type="checkbox" name="correct_position" value="'+i+'" '+(selected.includes(String(i))?'checked':'')+'> '+String.fromCharCode(65+i)+'</label>').join("");
    optionCount.textContent=rows.length+" من 5";
    addOption.disabled=rows.length>=5;
   };
   addOption.onclick=()=>{
    const rows=optionsWrap.querySelectorAll(".quiz-option-editor-row");
    if(rows.length>=5)return;
    const row=document.createElement("div");row.className="quiz-option-editor-row";
    row.innerHTML='<label class="form-label"><span></span><input class="form-control" name="option_text" maxlength="1000" required></label><button type="button" class="btn-danger-soft" data-remove-option aria-label="حذف الخيار">حذف</button>';
    optionsWrap.appendChild(row);syncOptionEditor();row.querySelector("input").focus();
   };
   optionsWrap.addEventListener("click",e=>{
    const remove=e.target.closest("[data-remove-option]");
    if(!remove)return;
    if(optionsWrap.querySelectorAll(".quiz-option-editor-row").length<=3)return;
    remove.closest(".quiz-option-editor-row").remove();syncOptionEditor();
   });
   syncOptionEditor();
   qf.onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(qf),opts=fd.getAll("option_text").map(x=>String(x).trim()),correctPositions=fd.getAll("correct_position").map(Number),quizId=String(fd.get("quiz_id"));
    if(opts.length<3||opts.length>5||opts.some(x=>!x)||!correctPositions.length){learningMsg(msg,"أدخل 3 إلى 5 خيارات وحدد إجابة صحيحة واحدة على الأقل، ولا تترك خيارًا فارغًا.",true);return;}
    const submit=qf.querySelector('button[type="submit"]');submit.disabled=true;submit.textContent="جارٍ حفظ السؤال...";
    const {data:lastQuestion,error:positionError}=await supabase.from("quiz_questions").select("position").eq("quiz_id",quizId).order("position",{ascending:false}).limit(1).maybeSingle();
    if(positionError){submit.disabled=false;submit.textContent="حفظ السؤال والتصحيح";learningMsg(msg,"تعذر تحديد ترتيب السؤال: "+positionError.message,true);return;}
    const {data:q,error:qe}=await supabase.from("quiz_questions").insert({quiz_id:quizId,prompt:String(fd.get("prompt")).trim(),position:(lastQuestion?.position||0)+1}).select("id").single();
    if(qe){submit.disabled=false;submit.textContent="حفظ السؤال والتصحيح";learningMsg(msg,"تعذر حفظ السؤال: "+qe.message,true);return;}
    const {data:created,error:oe}=await supabase.from("quiz_options").insert(opts.map((option_text,i)=>({question_id:q.id,option_text,position:i+1}))).select("id,position");
    if(oe){await supabase.from("quiz_questions").delete().eq("id",q.id);submit.disabled=false;submit.textContent="حفظ السؤال والتصحيح";learningMsg(msg,"تعذر حفظ الخيارات: "+oe.message,true);return;}
    const correctIds=created.filter(x=>correctPositions.includes(x.position-1)).map(x=>({question_id:q.id,option_id:x.id}));
    const {error:ke}=await supabase.from("quiz_correct_options").insert(correctIds);
    if(ke){await supabase.from("quiz_questions").delete().eq("id",q.id);submit.disabled=false;submit.textContent="حفظ السؤال والتصحيح";learningMsg(msg,"تعذر حفظ الإجابات الصحيحة: "+ke.message,true);return;}
    await renderLearningFeaturePage(page,kind);
    learningMsg(page.querySelector("#learnMsg"),"تم حفظ السؤال مع "+opts.length+" خيارات و"+correctIds.length+" إجابة صحيحة. سيصل إشعار للطلاب المعنيين.",false);
   };
  }
  const nf=body.querySelector("#newQuiz");
  if(nf){
   const subjectSelect=nf.querySelector('[name="subject_id"]'),customSubject=nf.querySelector('[name="custom_subject"]');
   subjectSelect.onchange=()=>{customSubject.style.display=subjectSelect.value==="other"?"block":"none";customSubject.required=subjectSelect.value==="other";};
   nf.onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(nf),selectedSubject=String(fd.get("subject_id")),subjectId=selectedSubject==="other"?String(fd.get("custom_subject")||"").trim():selectedSubject;
    const groupNo=isHead?ownGroup:(fd.get("group_no")?Number(fd.get("group_no")):null);
    if(!subjectId){learningMsg(msg,"اختر المادة أو اكتب اسم مادة مخصصة.",true);return;}
    if(isHead&&(!Number.isInteger(ownGroup)||ownGroup<1||ownGroup>10)){learningMsg(msg,"لم يتم تحديد فوج رئيس القسم بشكل صحيح.",true);return;}
    const payload={title:String(fd.get("title")).trim(),description:String(fd.get("description")||""),subject_id:subjectId,group_no:groupNo,is_published:true,created_by:uid};
    if(fd.get("duration_minutes"))payload.duration_minutes=Number(fd.get("duration_minutes"));
    const submit=nf.querySelector('button[type="submit"]');submit.disabled=true;submit.textContent="جارٍ إنشاء الاختبار...";
    const {data:created,error:err}=await supabase.from("quizzes").insert(payload).select("id").single();
    if(err){submit.disabled=false;submit.textContent="إنشاء الاختبار";learningMsg(msg,"تعذر إنشاء الاختبار. الدور الحالي: "+state.role+". تفاصيل قاعدة البيانات: "+err.message,true);return;}
    await renderLearningFeaturePage(page,kind);
    learningMsg(page.querySelector("#learnMsg"),"تم إنشاء الاختبار بنجاح. أضف أسئلته الآن من قسم إضافة سؤال QCM. تم إرسال إشعار للطلاب المعنيين.",false);
   };
  }
  body.querySelectorAll("[data-delete-question]").forEach(btn=>btn.onclick=async()=>{
   if(!confirm("نقل هذا السؤال إلى سلة المحذوفات؟ ستبقى نتائج الطلاب محفوظة ويمكن للمالك استرجاعه."))return;
   btn.disabled=true;
   const {error:delError}=await supabase.from("quiz_questions").update({deleted_at:new Date().toISOString(),deleted_by:uid}).eq("id",btn.dataset.deleteQuestion);
   if(delError){btn.disabled=false;learningMsg(msg,"تعذر نقل السؤال: "+delError.message,true);return;}
   await renderLearningFeaturePage(page,kind);learningMsg(page.querySelector("#learnMsg"),"نُقل السؤال إلى سلة المحذوفات ويمكن للمالك استرجاعه.",false);
  });
  body.querySelectorAll("[data-delete-quiz]").forEach(btn=>btn.onclick=async()=>{
   if(!confirm("نقل هذا الاختبار إلى سلة المحذوفات؟ لن تُحذف نتائج الطلاب ويمكن للمالك استرجاعه."))return;
   btn.disabled=true;
   const {error:delError}=await supabase.from("quizzes").update({deleted_at:new Date().toISOString(),deleted_by:uid,updated_at:new Date().toISOString()}).eq("id",btn.dataset.deleteQuiz);
   if(delError){btn.disabled=false;learningMsg(msg,"تعذر نقل الاختبار: "+delError.message,true);return;}
   await renderLearningFeaturePage(page,kind);learningMsg(page.querySelector("#learnMsg"),"نُقل الاختبار إلى سلة المحذوفات مع الاحتفاظ بنتائج الطلاب.",false);
  });
  if(state.role==="owner"){
   const {data:trashedQuizzes, error:trashError}=await supabase.from("quizzes").select("id,title,deleted_at").not("deleted_at","is",null).order("deleted_at",{ascending:false});
   const {data:trashedQuestions}=await supabase.from("quiz_questions").select("id,quiz_id,prompt,deleted_at,quizzes(title)").not("deleted_at","is",null).order("deleted_at",{ascending:false});
   const trashHtml=(trashedQuizzes||[]).map(q=>'<div class="learning-item"><span><strong>'+escapeHtml(q.title)+'</strong><small>اختبار محذوف · '+new Date(q.deleted_at).toLocaleString("ar")+'</small></span><button type="button" class="btn-secondary" data-restore-quiz="'+q.id+'">استرجاع</button></div>').join("")+
    (trashedQuestions||[]).map(q=>'<div class="learning-item"><span><strong>'+escapeHtml(q.prompt)+'</strong><small>سؤال من: '+escapeHtml(q.quizzes?.title||"اختبار")+'</small></span><button type="button" class="btn-secondary" data-restore-question="'+q.id+'">استرجاع السؤال</button></div>').join("");
   body.insertAdjacentHTML("beforeend",'<section class="content-card" style="margin-top:16px"><h3>سلة محذوفات QCM</h3><p class="learning-hint">يمكنك استرجاع الاختبارات والأسئلة المحذوفة دون فقدان النتائج السابقة.</p><div class="learning-list">'+(trashHtml||'<p class="empty-state">سلة المحذوفات فارغة.</p>')+'</div></section>');
   body.querySelectorAll("[data-restore-quiz]").forEach(btn=>btn.onclick=async()=>{btn.disabled=true;const {error}=await supabase.rpc("owner_restore_quiz",{p_quiz_id:btn.dataset.restoreQuiz});if(error){btn.disabled=false;learningMsg(msg,"تعذر استرجاع الاختبار: "+error.message,true);return;}await renderLearningFeaturePage(page,kind);learningMsg(page.querySelector("#learnMsg"),"تم استرجاع الاختبار بنجاح.",false);});
   body.querySelectorAll("[data-restore-question]").forEach(btn=>btn.onclick=async()=>{btn.disabled=true;const {error}=await supabase.rpc("owner_restore_quiz_question",{p_question_id:btn.dataset.restoreQuestion});if(error){btn.disabled=false;learningMsg(msg,"تعذر استرجاع السؤال: "+error.message,true);return;}await renderLearningFeaturePage(page,kind);learningMsg(page.querySelector("#learnMsg"),"تم استرجاع السؤال بنجاح.",false);});
  }
  return;
 }
 if(kind==="progress"){
  const [fr,pr,ar,mr]=await Promise.all([
   supabase.from("files").select("id,title,subject,kind,semester").limit(1000),
   supabase.from("student_file_progress").select("file_id,status").eq("user_id",uid),
   supabase.from("quiz_attempts").select("id,score,max_score,submitted_at").eq("student_id",uid),
   supabase.from("study_plan_items").select("id,is_completed").eq("user_id",uid)
  ]);
  if(fr.error||pr.error||ar.error||mr.error){body.textContent="تعذر تحميل التقدم الدراسي: "+escapeHtml(fr.error?.message||pr.error?.message||ar.error?.message||mr.error?.message||"خطأ غير معروف");return;}
  const files=(fr.data||[]).filter(f=>f.subject!=="__schedule_pdf__"),done=new Set((pr.data||[]).filter(x=>x.status==="completed").map(x=>String(x.file_id)));
  const completedFiles=files.filter(f=>done.has(String(f.id))).length,yearPct=files.length?Math.round(completedFiles/files.length*100):0;
  const subjectStats=new Map(),semesterStats=new Map();
  files.forEach(file=>{
   const sid=normalizeSubjectId(file.subject),semester=String(file.semester||"غير محدد").trim()||"غير محدد",isDone=done.has(String(file.id));
   if(!subjectStats.has(sid))subjectStats.set(sid,{total:0,done:0,semesters:new Map()});
   const s=subjectStats.get(sid);s.total++;if(isDone)s.done++;
   if(!s.semesters.has(semester))s.semesters.set(semester,{total:0,done:0});
   const ss=s.semesters.get(semester);ss.total++;if(isDone)ss.done++;
   if(!semesterStats.has(semester))semesterStats.set(semester,{total:0,done:0});
   const st=semesterStats.get(semester);st.total++;if(isDone)st.done++;
  });
  const pct=(n,total)=>total?Math.round(n/total*100):0;
  const progressBar=(value)=>'<div class="progress-track"><span style="width:'+value+'%"></span></div>';
  const subjectRows=[...subjectStats.entries()].sort((a,b)=>subj(a[0]).localeCompare(subj(b[0]))).map(([sid,s])=>{
   const value=pct(s.done,s.total),semesterText=[...s.semesters.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([sem,x])=>sem+': '+pct(x.done,x.total)+'%').join(' · ');
   return '<article class="subject-progress-item"><div class="subject-progress-heading"><strong>'+escapeHtml(subj(sid))+'</strong><b>'+value+'%</b></div>'+progressBar(value)+'<small>'+s.done+' من '+s.total+' ملف مكتمل · '+escapeHtml(semesterText)+'</small></article>';
  }).join("");
  const semesterCards=[...semesterStats.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([sem,s])=>{
   const value=pct(s.done,s.total);
   return '<div class="semester-progress-card"><div class="subject-progress-heading"><strong>'+escapeHtml(sem==="غير محدد"?"السداسي غير المحدد":sem)+'</strong><b>'+value+'%</b></div>'+progressBar(value)+'<small>'+s.done+' من '+s.total+' ملف مكتمل</small></div>';
  }).join("");
  const completedTasks=(mr.data||[]).filter(x=>x.is_completed).length,attemptCount=(ar.data||[]).length;
  const avgQuiz=attemptCount?Math.round((ar.data||[]).reduce((sum,x)=>sum+(Number(x.max_score)>0?Number(x.score)/Number(x.max_score)*100:0),0)/attemptCount):null;
  body.innerHTML='<div class="progress-summary"><div class="content-card"><strong>'+yearPct+'%</strong><span>التقدم العام خلال السنة الدراسية</span><small>'+completedFiles+' من '+files.length+' ملف مكتمل</small></div><div class="content-card"><strong>'+completedTasks+'</strong><span>مهام مراجعة مكتملة</span></div><div class="content-card"><strong>'+attemptCount+'</strong><span>اختبارات منجزة</span></div><div class="content-card"><strong>'+(avgQuiz===null?"—":avgQuiz+"%")+'</strong><span>متوسط نتائج QCM</span></div></div>'+
  '<section class="content-card"><h3>التقدم حسب السداسي</h3><p class="learning-hint">تُحسب النسبة من الملفات المتاحة في كل سداسي والتي علّمتها كمكتملة.</p><div class="semester-progress-grid">'+(semesterCards||'<p class="empty-state">لا توجد ملفات مرتبطة بسداسي بعد.</p>')+'</div></section>'+
  '<section class="content-card" style="margin-top:16px"><h3>التقدم في كل مادة</h3><p class="learning-hint">كل مادة لها نسبة مستقلة، ويظهر تحتها توزيع التقدم حسب السداسي.</p><div class="subject-progress-list">'+(subjectRows||'<p class="empty-state">لا توجد مواد أو ملفات متاحة لقياس التقدم.</p>')+'</div></section>'+
  '<section class="content-card" style="margin-top:16px"><h3>ملفاتك الدراسية</h3><p>علّم الملف بعد الانتهاء من دراسته؛ مجرد فتحه لا يُحتسب إنجازًا.</p><div class="learning-list">'+files.map(file=>'<label class="learning-item"><span><strong>'+escapeHtml(file.title||"ملف")+'</strong><small>'+escapeHtml(subj(normalizeSubjectId(file.subject)))+' · '+escapeHtml(file.kind||"")+' · '+escapeHtml(file.semester||"سداسي غير محدد")+'</small></span><input type="checkbox" data-progress-file="'+file.id+'" '+(done.has(String(file.id))?"checked":"")+'></label>').join("")+'</div></section>';
  body.querySelectorAll("[data-progress-file]").forEach(cb=>cb.onchange=async()=>{
   const {error:err}=await supabase.from("student_file_progress").upsert({user_id:uid,file_id:Number(cb.dataset.progressFile),status:cb.checked?"completed":"studying",updated_at:new Date().toISOString()},{onConflict:"user_id,file_id"});
   if(err)learningMsg(msg,err.message,true);else await renderLearningFeaturePage(page,kind);
  });
  return;
 }
 if(kind==="preferences"){
  const {data:p}=await supabase.from("user_preferences").select("*").eq("user_id",uid).maybeSingle();
  body.innerHTML='<section class="content-card"><form id="prefForm" class="learning-form"><label>المظهر<select name="theme" class="form-control"><option value="light">فاتح</option><option value="dark">داكن</option><option value="system">حسب الجهاز</option></select></label><label>حجم الخط<select name="font_scale" class="form-control"><option value="0.9">صغير</option><option value="1">عادي</option><option value="1.1">كبير</option><option value="1.2">كبير جدًا</option></select></label><label><input type="checkbox" name="compact_mode"> عرض مدمج</label><button class="btn-primary">حفظ</button></form></section>';
  const pf=body.querySelector("#prefForm");pf.elements.theme.value=p?.theme||"light";pf.elements.font_scale.value=String(p?.font_scale||1);pf.elements.compact_mode.checked=!!p?.compact_mode;
  pf.onsubmit=async e=>{e.preventDefault();const theme=pf.elements.theme.value,scale=Number(pf.elements.font_scale.value);const {error:err}=await supabase.from("user_preferences").upsert({user_id:uid,theme,font_scale:scale,compact_mode:pf.elements.compact_mode.checked,updated_at:new Date().toISOString()},{onConflict:"user_id"});if(err){learningMsg(msg,err.message,true);return;}applyThemePreference(theme==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):theme);document.documentElement.style.setProperty("--user-font-scale",String(scale));document.documentElement.classList.toggle("compact-mode",pf.elements.compact_mode.checked);learningMsg(msg,"تم حفظ التفضيلات.");};return;
 }
 if(kind==="insights"){
  const tables=["files","student_profiles","teacher_info","notifications","student_conversations","quizzes","discussion_questions","admin_activity_log"],labels=["الملفات","الطلاب","الأساتذة","الإشعارات","المحادثات","الاختبارات","الأسئلة","سجل النشاطات"];
  const counts=await Promise.all(tables.map(async t=>{const {count,error}=await supabase.from(t).select("*",{count:"exact",head:true});return {count,error};}));
  const [{data:logs},{data:recentFiles}]=await Promise.all([supabase.from("admin_activity_log").select("action,table_name,record_id,created_at").order("created_at",{ascending:false}).limit(40),supabase.from("files").select("id,title,subject,kind,group_no,created_at").order("created_at",{ascending:false}).limit(20)]);
  body.innerHTML='<div class="progress-summary">'+counts.map((x,i)=>'<div class="content-card"><strong>'+(x.error?"—":x.count)+'</strong><span>'+labels[i]+'</span></div>').join("")+'</div><section class="content-card"><h3>آخر النشاطات</h3><div class="learning-list">'+(logs||[]).map(l=>'<div class="learning-item"><span><strong>'+escapeHtml(l.action)+'</strong><small>'+escapeHtml(l.table_name)+' · '+escapeHtml(l.record_id||"—")+'</small></span><small>'+new Date(l.created_at).toLocaleString("ar")+'</small></div>').join("")+'</div></section><section class="content-card" style="margin-top:16px"><h3>آخر الملفات المضافة أو المعدلة</h3><div class="learning-list">'+(recentFiles||[]).map(x=>'<div class="learning-item"><span><strong>'+escapeHtml(x.title)+'</strong><small>'+escapeHtml(x.subject)+' · '+escapeHtml(x.kind)+' · '+(x.group_no?"G"+x.group_no:"مشترك") +'</small></span><small>'+new Date(x.created_at).toLocaleDateString("ar")+'</small></div>').join("")+'</div></section>';return;
 }
}
async function renderCoursePolls(body,uid,role,uploaderGroup,page){
 const staff=["owner","admin","uploader"].includes(role),isHead=role==="uploader",group=Number(uploaderGroup);
 const {data:polls,error}=await supabase.from("course_polls").select("id,title,description,group_no,allow_multiple,is_active,closes_at").order("created_at",{ascending:false}).limit(40);
 if(error){body.insertAdjacentHTML("beforeend",'<section class="content-card"><h3>التصويت</h3><p class="empty-state">تعذر تحميل التصويت: '+escapeHtml(error.message)+'</p></section>');return;}
 const pollIds=(polls||[]).map(p=>p.id);
 const {data:pollOptions,error:optionsError}=pollIds.length?await supabase.from("course_poll_options").select("id,poll_id,option_text,position").in("poll_id",pollIds).order("position",{ascending:true}):{data:[],error:null};
 if(optionsError){body.insertAdjacentHTML("beforeend",'<section class="content-card"><h3>التصويت</h3><p class="empty-state">تعذر تحميل خيارات التصويت: '+escapeHtml(optionsError.message)+'</p></section>');return;}
 const optionsByPoll=new Map();(pollOptions||[]).forEach(o=>{if(!optionsByPoll.has(o.poll_id))optionsByPoll.set(o.poll_id,[]);optionsByPoll.get(o.poll_id).push(o);});
 let html='<section class="content-card poll-section"><h3>التصويت والاستطلاعات</h3><p class="learning-hint">شارك برأيك في استطلاعات المنصة. يمكن أن يسمح الاستطلاع باختيار إجابة واحدة أو عدة إجابات.</p>';
 if(staff) html+='<details class="poll-create"><summary>إنشاء تصويت جديد</summary><form id="newPoll" class="learning-form"><label class="form-label">عنوان التصويت<input class="form-control" name="title" maxlength="240" required></label><label class="form-label">وصف أو توضيح<textarea class="form-control" name="description" maxlength="1000"></textarea></label>'+(isHead?'<input type="hidden" name="group_no" value="'+group+'"><p class="learning-hint">سيكون التصويت لفوجك فقط.</p>':'<label class="form-label">الفوج المستهدف<select class="form-control" name="group_no"><option value="">كل الأفواج</option>'+Array.from({length:10},(_,i)=>'<option value="'+(i+1)+'">G'+(i+1)+'</option>').join("")+'</select></label>')+'<label class="form-label">نوع التصويت<select class="form-control" name="allow_multiple"><option value="false">اختيار واحد</option><option value="true">اختيار عدة خيارات</option></select></label><div class="poll-option-inputs"><label class="form-label">الخيار الأول<input class="form-control" name="option_text" required maxlength="500"></label><label class="form-label">الخيار الثاني<input class="form-control" name="option_text" required maxlength="500"></label><label class="form-label">الخيار الثالث<input class="form-control" name="option_text" maxlength="500"></label><label class="form-label">الخيار الرابع<input class="form-control" name="option_text" maxlength="500"></label></div><div class="poll-form-message"></div><button class="btn-primary">نشر التصويت</button></form></details>';
 html+='<div class="learning-list poll-list">';
 for(const p of polls||[]){
  const {data:result,error:resultError}=await supabase.rpc("get_course_poll_results",{p_poll_id:p.id});
  const mine=(result?.my_votes||[]).map(String),opts=optionsByPoll.get(p.id)||[];
  const closed=!p.is_active||(p.closes_at&&new Date(p.closes_at)<=new Date());
  html+='<article class="learning-item poll-card"><div class="poll-card-heading"><strong>'+escapeHtml(p.title)+'</strong><small>'+(p.group_no?'G'+p.group_no:'كل الأفواج')+' · '+(p.allow_multiple?'اختيارات متعددة':'اختيار واحد')+'</small></div>'+(p.description?'<p>'+escapeHtml(p.description)+'</p>':'')+'<form class="poll-vote-form" data-poll="'+p.id+'">'+opts.map(o=>'<label class="quiz-option"><input type="'+(p.allow_multiple?'checkbox':'radio')+'" name="poll_'+p.id+'" value="'+o.id+'" '+(mine.includes(String(o.id))?'checked':'')+' '+(closed?'disabled':'')+'><span>'+escapeHtml(o.option_text)+'</span></label>').join("")+(closed?'<p class="learning-hint">هذا التصويت مغلق.</p>':'<button class="btn-secondary">إرسال / تحديث تصويتي</button>')+'<div class="poll-form-message"></div></form>';
  if(resultError) html+='<p class="learning-hint">تعذر عرض النتائج.</p>';
  else html+='<div class="poll-results"><strong>'+Number(result?.total_votes||0)+' مشارك</strong>'+(result?.options||[]).map(o=>{const n=Number(o.votes||0),total=Number(result?.total_votes||0),pct=total?Math.round(n/total*100):0;return '<div class="poll-result-row"><span>'+escapeHtml(o.text)+'</span><b>'+n+' ('+pct+'%)</b><div class="progress-track"><span style="width:'+pct+'%"></span></div></div>';}).join("")+'</div>';
  html+='</article>';
 }
 html+='</div></section>';
 body.insertAdjacentHTML("beforeend",html);
 const form=body.querySelector("#newPoll");
 if(form)form.onsubmit=async e=>{e.preventDefault();const fd=new FormData(form),opts=fd.getAll("option_text").map(x=>String(x).trim()).filter(Boolean);if(opts.length<2){learningMsg(form.querySelector(".poll-form-message"),"أدخل خيارين على الأقل.",true);return;}const groupNo=isHead?group:(fd.get("group_no")?Number(fd.get("group_no")):null);const btn=form.querySelector("button");btn.disabled=true;const {data:p,error:pe}=await supabase.from("course_polls").insert({title:String(fd.get("title")).trim(),description:String(fd.get("description")||"").trim(),group_no:groupNo,allow_multiple:fd.get("allow_multiple")==="true",created_by:uid}).select("id").single();if(pe){btn.disabled=false;learningMsg(form.querySelector(".poll-form-message"),pe.message,true);return;}const {error:oe}=await supabase.from("course_poll_options").insert(opts.map((option_text,i)=>({poll_id:p.id,option_text,position:i+1})));if(oe){learningMsg(form.querySelector(".poll-form-message"),"تم إنشاء التصويت لكن تعذرت إضافة الخيارات: "+oe.message,true);return;}await renderLearningFeaturePage(page,"quizzes");};
 body.querySelectorAll(".poll-vote-form").forEach(form=>form.onsubmit=async e=>{e.preventDefault();const values=[...form.querySelectorAll('input:checked')].map(x=>x.value);if(!values.length){learningMsg(form.querySelector(".poll-form-message"),"اختر خيارًا واحدًا على الأقل.",true);return;}const btn=form.querySelector("button");if(btn)btn.disabled=true;const {error}=await supabase.rpc("cast_course_poll_vote",{p_poll_id:form.dataset.poll,p_option_ids:values});if(error){if(btn)btn.disabled=false;learningMsg(form.querySelector(".poll-form-message"),error.message,true);return;}await renderLearningFeaturePage(page,"quizzes");});
}
async function renderQuizAttemptPage(page,quizId){
 page.innerHTML='<div class="content-card">جارٍ تحميل الاختبار…</div>';
 const {data:q,error}=await supabase.from("quizzes").select("id,title,description").eq("id",quizId).is("deleted_at",null).single();
 if(error){page.innerHTML='<div class="content-card">الاختبار غير متاح.</div>';return;}
 const {data:qs,error:qe}=await supabase.from("quiz_questions").select("id,prompt,position,points,quiz_options(id,option_text,position)").eq("quiz_id",quizId).is("deleted_at",null).order("position");
 if(qe||!qs?.length){page.innerHTML='<div class="content-card">لا توجد أسئلة بعد.</div>';return;}
 page.innerHTML='<div class="page-banner"><h2>'+escapeHtml(q.title)+'</h2><p>'+escapeHtml(q.description||"أجب عن الأسئلة ثم أرسلها للتصحيح.")+'</p></div><form id="attemptForm" class="content-card learning-form">'+qs.map((x,i)=>'<fieldset class="quiz-question"><legend>'+(i+1)+'. '+escapeHtml(x.prompt)+'</legend><p class="learning-hint">يمكن اختيار أكثر من إجابة.</p>'+(x.quiz_options||[]).sort((a,b)=>a.position-b.position).map((o,j)=>'<label class="quiz-option"><input type="checkbox" name="q_'+x.id+'" value="'+o.id+'"><span>'+String.fromCharCode(65+j)+'. '+escapeHtml(o.option_text)+'</span></label>').join("")+'</fieldset>').join("")+'<button class="btn-primary">إرسال وتصحيح</button><div id="attemptResult"></div></form>';
 page.querySelector("#attemptForm").onsubmit=async e=>{
  e.preventDefault();
  const fd=new FormData(e.currentTarget),answers=qs.map(x=>({question_id:x.id,option_ids:fd.getAll("q_"+x.id)}));
  if(answers.some(a=>!a.option_ids.length)){learningMsg(page.querySelector("#attemptResult"),"اختر إجابة واحدة على الأقل لكل سؤال.",true);return;}
  const submit=e.currentTarget.querySelector("button");submit.disabled=true;
  const {data,error:err}=await supabase.rpc("submit_quiz_attempt",{p_quiz_id:quizId,p_answers:answers});
  const box=page.querySelector("#attemptResult");
  if(err){submit.disabled=false;learningMsg(box,err.message,true);return;}
  box.innerHTML='<div class="auth-success-box" style="display:block">نتيجتك: <strong>'+data.score+' / '+data.max_score+'</strong></div>';
 };
}

// 12. PAGE: HOME (#/)
function renderHomeView(page) {
  const sg = state.studentGroup;
  const userLabel = state.studentDisplayName || state.user.email?.split("@")[0] || "طالب";
  const availableFiles = Array.isArray(state.filesCache) ? state.filesCache.length : 0;
  const quickLinks = [
    { href: "#/search", icon: "file", title: "ملفاتي", desc: "الدروس والملفات المتاحة لك" },
    { href: "#/groupes", icon: "book", title: "المواد الدراسية", desc: "المواد والأفواج الدراسية" },
    { href: "#/horaire", icon: "calendar", title: "جدولي الزمني", desc: "مواعيد المحاضرات والحصص" },
    { href: "#/teachers", icon: "users", title: "الأساتذة", desc: "معلومات الأساتذة وطرق التواصل" },
    { href: "#/exams", icon: "exam", title: "أرشيف الامتحانات", desc: "امتحانات سابقة للمراجعة" },
    { href: "#/quizzes", icon: "check", title: "اختبارات QCM", desc: "اختبر معلوماتك وصحّح إجاباتك" }
  ];
  const icons = {
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.75h8l4 4v12.5H6z"/><path d="M14 3.75v4h4M9 12h6M9 15.5h6"/></svg>',
    exam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.4A4.6 4.6 0 0 1 8.1 13h1.8a4.6 4.6 0 0 1 4.6 4.6V19zM16 5.5a3 3 0 0 1 0 5.8M17 13.5a4.3 4.3 0 0 1 3.5 4.2V19h-3"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 9.5h16M8 13h2M13 13h3M8 16.5h2"/></svg>',
    book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A3 3 0 0 1 7 3h5v17H7a3 3 0 0 0-3 1zM20 5.5A3 3 0 0 0 17 3h-5v17h5a3 3 0 0 1 3 1z"/><path d="M7 7h2M15 7h2"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 12 2.5 2.5L16.5 9"/></svg>'
  };
  page.innerHTML = `
    <section class="home-hero">
      <div class="home-hero-copy">
        <span class="home-eyebrow">منصتك الأكاديمية في مكان واحد</span>
        <h1><bdi>info cc 404</bdi></h1>
        <h2>منصتك الأكاديمية لتنظيم الوصول إلى ملفاتكم الدراسية</h2>
        <div class="home-hero-rule"></div>
        <h3>مرحباً بكم، ${escapeHtml(userLabel)}</h3>
        <p>هنا تجد مواردك الدراسية، والمواد، ومعلومات الأساتذة، والإعلانات المهمة في مساحة واحدة واضحة ومنظمة.</p>
        <div class="home-hero-meta"><span class="home-meta-dot"></span><span>${sg ? `حسابك مرتبط بالفوج G${sg}` : 'نتمنى لك فصلاً دراسياً مليئاً بالنجاح'}</span></div>
        <a href="#/search" class="home-hero-cta">تصفح الملفات <span aria-hidden="true">←</span></a>
      </div>
      <div class="home-hero-art home-graduation-art" aria-hidden="true">
        <div class="home-campus"></div>
        <div class="home-book-stack"><span></span><span></span><span></span></div>
        <div class="home-cap"><i></i></div>
      </div>
    </section>

    <section class="home-description content-card" aria-labelledby="homeDescriptionTitle">
      <div class="home-description-heading">
        <span class="home-description-kicker">مساحة دراسية متكاملة لطلبة الإعلام الآلي</span>
        <h2 id="homeDescriptionTitle">كل ما تحتاجه لتنظيم دراستك في مكان واحد</h2>
        <p>info cc 404 منصة أكاديمية تجمع الموارد التعليمية والخدمات المساندة لطلبة الإعلام الآلي. صُممت لتسهيل الوصول إلى الدروس والملفات حسب الفوج، ومتابعة المستجدات، وتنظيم المراجعة والتواصل الدراسي.</p>
      </div>
      <div class="home-feature-list">
        <div><b>الموارد والملفات</b><span>دروس وملفات Cours وTD وTP قابلة للبحث والتنزيل، مع تنظيم الوصول حسب الفوج.</span></div>
        <div><b>المواد والأفواج</b><span>تنظيم المواد الدراسية والأفواج العشرة G1 إلى G10.</span></div>
        <div><b>الأساتذة</b><span>دليل الأساتذة ومعلوماتهم وملفاتهم حسب المادة ونوع الحصة.</span></div>
        <div><b>الامتحانات وQCM</b><span>أرشيف الامتحانات السابقة واختبارات اختيار من متعدد مع تصحيح تلقائي.</span></div>
        <div><b>التنظيم والمتابعة</b><span>الجدول الدراسي، خطة المراجعة، الملاحظات، ومتابعة تقدمك الدراسي.</span></div>
        <div><b>التواصل والإعلانات</b><span>إعلانات وتنبيهات، مساحة للأسئلة والنقاش، ومراسلة الإدارة.</span></div>
      </div>
    </section>

    <section class="home-stats" aria-label="ملخص المنصة">
      <article class="home-stat"><span class="home-stat-icon">${icons.file}</span><div><strong>${availableFiles.toLocaleString("en-US")}</strong><span>ملف متاح</span></div></article>
      <article class="home-stat"><span class="home-stat-icon">${icons.users}</span><div><strong>10</strong><span>أفواج دراسية</span></div></article>
      <article class="home-stat"><span class="home-stat-icon">${icons.book}</span><div><strong>7</strong><span>مواد دراسية</span></div></article>
      <article class="home-stat"><span class="home-stat-icon">${icons.calendar}</span><div><strong>${sg ? `G${sg}` : '—'}</strong><span>فوجك الدراسي</span></div></article>
    </section>

    ${!sg && state.role === 'student' ? `<section class="home-group-notice"><div><strong>لم يتم تعيين فوجك بعد</strong><p>حدّد فوجك من صفحة الحساب وأرسل طلباً للإدارة حتى تظهر لك الملفات الخاصة بفوجك.</p></div><a href="#/compte" class="btn-primary">إعداد حسابي</a></section>` : ''}

    <section class="home-dashboard-grid">
      <div class="home-dashboard-panel">
        <div class="home-panel-heading"><h2>الوصول السريع</h2><span class="home-panel-mark">✦</span></div>
        <div class="home-quick-grid">
          ${quickLinks.map(c => `<a href="${c.href}" class="home-quick-card"><span class="home-quick-icon">${icons[c.icon]}</span><strong>${c.title}</strong><small>${c.desc}</small></a>`).join("")}
        </div>
      </div>
      <div class="home-dashboard-panel home-announcement-panel">
        <div class="home-panel-heading"><h2>آخر الإعلانات</h2><span class="home-panel-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l9 4V6l-9 4zM8 14l2 6h3l-2-5M19 9a4 4 0 0 0 0 6"/></svg></span></div>
        <div class="home-announcement-empty">
          <span class="home-announcement-symbol"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l9 4V6l-9 4zM8 14l2 6h3l-2-5M19 9a4 4 0 0 0 0 6"/></svg></span>
          <strong>تابع جديد الإعلانات والتنبيهات</strong>
          <p>ستجد هنا صفحة الإعلانات الرسمية وكل المستجدات المتعلقة بدراستك.</p>
          <a href="#/announcements">عرض جميع الإعلانات <span aria-hidden="true">←</span></a>
        </div>
      </div>
    </section>
    <footer class="home-footer"><span><bdi>info cc 404</bdi> © ${new Date().getFullYear()} — جميع الحقوق محفوظة</span><span>بالعلم نبني مستقبلاً أفضل</span></footer>
  `;
}

function isWithinDays(dateStr, days) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now - d) / (1000 * 60 * 60 * 24);
  return diff <= days;
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toISOString().split("T")[0];
  } catch (e) {
    return dateStr;
  }
}

// 13. PAGE: GROUPES (#/groupes)
function renderGroupesView(page) {
  // Only students and group heads have a home group. Owners/admins oversee all groups.
  const sg = state.role === "owner" || state.role === "admin"
    ? null
    : (state.role === "uploader" ? state.uploaderGroup : state.studentGroup);
  page.innerHTML = `
    <div class="page-banner">
      <h2>الأفواج الدراسية (<span class="mono">G1 - G10</span>)</h2>
      <p>اختر أي فوج للاطلاع على تفاصيل أساتذة الـ TD والـ TP وملفات الدروس الخاصة به.</p>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px;">
      ${[1,2,3,4,5,6,7,8,9,10].map(g => `
        <a href="#/groupe/${g}" class="content-card" style="display: flex; flex-direction: column; align-items: center; text-align: center; padding: 24px 16px; text-decoration: none; border: 1px solid ${sg && g === sg ? 'var(--brown)' : 'var(--line)'}; position: relative;">
          ${sg && g === sg ? `<span style="position: absolute; top: 10px; left: 10px; background-color: var(--brown); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 500;">فوجك</span>` : ''}
          <div class="logo-badge-small mono" style="font-size: 16px; padding: 6px 14px; margin-bottom: 12px;">G${g}</div>
          <div style="font-weight: 600; font-size: 16px; color: var(--brown-dark);">الفوج ${g}</div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">تصفح الدروس والملفات</div>
        </a>
      `).join("")}
    </div>
  `;
}

// 14. PAGE: GROUPE DETAIL (#/groupe/N/...)
function renderGroupDetailView(page, groupNo, tab = "cours", subjectId = null) {
  if (groupNo < 1 || groupNo > 10) {
    renderNotFoundView(page);
    return;
  }

  if (subjectId) {
    renderSubjectLessonsView(page, groupNo, tab, subjectId);
    return;
  }

  const isOwner = canManageContent(); // owner or admin (kept name for the markup below)

  page.innerHTML = `
    <div class="breadcrumb">
      <a href="#/groupes">الأفواج</a>
      <span>›</span>
      <span class="current mono">G${groupNo}</span>
    </div>

    <div class="page-banner">
      <h2>الفوج <span class="mono">G${groupNo}</span></h2>
      <p>Browse your group’s subjects and study files by category.</p>
    </div>

    <div class="group-tabs">
      <button type="button" class="group-tab-btn ${tab === 'cours' ? 'active' : ''}" data-tab="cours">الكور</button>
      <button type="button" class="group-tab-btn mono ${tab === 'td' ? 'active' : ''}" data-tab="td">TD</button>
      <button type="button" class="group-tab-btn mono ${tab === 'tp' ? 'active' : ''}" data-tab="tp">TP</button>
      <button type="button" class="group-tab-btn ${tab === 'exam' ? 'active' : ''}" data-tab="exam">الامتحانات</button>
    </div>

    <div id="groupTabContent">
      <!-- Injected Tab Content -->
    </div>
  `;

  page.querySelectorAll(".group-tab-btn").forEach(btn => {
    btn.onclick = () => {
      const nextTab = btn.getAttribute("data-tab");
      location.hash = `#/groupe/${groupNo}/${nextTab}`;
    };
  });

  const tabContainer = document.getElementById("groupTabContent");

  if (tab === "cours") {
    tabContainer.innerHTML = `
      <div class="content-card">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 14px;">Course Lectures (Cours)</h3>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Course Teacher</th>
                <th>Files</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${SUBJECT_DEFINITIONS.map(sub => {
                const count = state.filesCache.filter(f =>
                  f.kind === "cours" &&
                  normalizeSubjectId(f.subject) === sub.id &&
                  (isSharedFile(f) || isFileForGroup(f, groupNo))
                ).length;
                const teacher = getResolvedTeacher("cours", sub.id, 0);
                return `
                  <tr>
                    <td>
                      <strong>${escapeHtml((sub.nameEn || sub.nameFr || sub.nameAr))}</strong>
                    </td>
                    <td>
                      <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-start; flex-wrap: wrap;">
                        ${renderTeacherDisplayHtml(teacher)}
                        ${
                          isOwner
                            ? `<button type="button" class="btn-secondary edit-teacher-btn" data-kind="cours" data-sub="${sub.id}" data-grp="0" style="padding: 2px 8px; font-size: 11px;">${teacher.name ? "تعديل" : "تعيين"}</button>`
                            : ""
                        }
                      </div>
                    </td>
                    <td><span class="badge-tag mono">${count}</span></td>
                    <td>
                      <a href="#/groupe/${groupNo}/cours/${sub.id}" class="btn-primary" style="padding: 4px 12px; font-size: 12px; width: auto; text-decoration: none;">
                        فتح الدروس
                      </a>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else if (tab === "td") {
    // Students see only subjects that have a teacher assigned or files for this group.
    // Owner/admin see every subject so they can assign teachers.
    const validSubs = SUBJECT_DEFINITIONS.filter(sub =>
      isOwner ||
      getResolvedTeacher("td", sub.id, groupNo).name ||
      state.filesCache.some(f =>
        f.kind === "td" &&
        normalizeSubjectId(f.subject) === sub.id &&
        isFileForGroup(f, groupNo)
      )
    );

    tabContainer.innerHTML = `
      <div class="content-card">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 14px;">Tutorial Sessions (TD) — Group G${groupNo}</h3>
        ${validSubs.length === 0 ? `<p style="color: var(--muted);">لم تُضف حصص TD لهذا الفوج بعد.</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>TD Teacher</th>
                  <th>Files</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${validSubs.map(sub => {
                  const count = state.filesCache.filter(f =>
                    f.kind === "td" &&
                    normalizeSubjectId(f.subject) === sub.id &&
                    isFileForGroup(f, groupNo)
                  ).length;
                  const teacher = getResolvedTeacher("td", sub.id, groupNo);
                  return `
                    <tr>
                      <td>
                        <strong>${escapeHtml((sub.nameEn || sub.nameFr || sub.nameAr))}</strong>
                      </td>
                      <td>
                        <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-start; flex-wrap: wrap;">
                          ${renderTeacherDisplayHtml(teacher)}
                          ${
                            isOwner
                              ? `<button type="button" class="btn-secondary edit-teacher-btn" data-kind="td" data-sub="${sub.id}" data-grp="${groupNo}" style="padding: 2px 8px; font-size: 11px;">${teacher.name ? "تعديل" : "تعيين"}</button>`
                              : ""
                          }
                        </div>
                      </td>
                      <td><span class="badge-tag mono">${count}</span></td>
                      <td>
                        <a href="#/groupe/${groupNo}/td/${sub.id}" class="btn-primary" style="padding: 4px 12px; font-size: 12px; width: auto; text-decoration: none;">
                          فتح
                        </a>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  } else if (tab === "tp") {
    // Students see only subjects that have a teacher assigned or files for this group.
    // Owner/admin see every subject so they can assign teachers.
    const validSubs = SUBJECT_DEFINITIONS.filter(sub =>
      isOwner ||
      getResolvedTeacher("tp", sub.id, groupNo).name ||
      state.filesCache.some(f =>
        f.kind === "tp" &&
        normalizeSubjectId(f.subject) === sub.id &&
        isFileForGroup(f, groupNo)
      )
    );

    tabContainer.innerHTML = `
      <div class="content-card">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 14px;">Practical Sessions (TP) — Group G${groupNo}</h3>
        ${validSubs.length === 0 ? `<p style="color: var(--muted);">لم تُضف حصص TP لهذا الفوج بعد.</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>TP Teacher</th>
                  <th>Files</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${validSubs.map(sub => {
                  const count = state.filesCache.filter(f =>
                    f.kind === "tp" &&
                    normalizeSubjectId(f.subject) === sub.id &&
                    isFileForGroup(f, groupNo)
                  ).length;
                  const teacher = getResolvedTeacher("tp", sub.id, groupNo);
                  return `
                    <tr>
                      <td>
                        <strong>${escapeHtml((sub.nameEn || sub.nameFr || sub.nameAr))}</strong>
                      </td>
                      <td>
                        <div style="display: flex; align-items: center; gap: 8px; justify-content: flex-start; flex-wrap: wrap;">
                          ${renderTeacherDisplayHtml(teacher)}
                          ${
                            isOwner
                              ? `<button type="button" class="btn-secondary edit-teacher-btn" data-kind="tp" data-sub="${sub.id}" data-grp="${groupNo}" style="padding: 2px 8px; font-size: 11px;">${teacher.name ? "تعديل" : "تعيين"}</button>`
                              : ""
                          }
                        </div>
                      </td>
                      <td><span class="badge-tag mono">${count}</span></td>
                      <td>
                        <a href="#/groupe/${groupNo}/tp/${sub.id}" class="btn-primary" style="padding: 4px 12px; font-size: 12px; width: auto; text-decoration: none;">
                          فتح
                        </a>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  } else if (tab === "exam") {
    const examFiles = state.filesCache.filter(f =>
      f.kind === "exam" && isFileForGroup(f, groupNo)
    );

    tabContainer.innerHTML = `
      <div class="content-card">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 14px;">الامتحانات والاختبارات السابقة — الفوج G${groupNo}</h3>
        ${examFiles.length === 0 ? `<p style="color: var(--muted); text-align: center; padding: 20px;">ما كاين حتى ملف بعد</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>العنوان</th>
                  <th>المادة</th>
                  <th>تاريخ الرفع</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${examFiles.map(f => `
                  <tr>
                    <td><strong>${escapeHtml(f.title)}</strong></td>
                    <td>${escapeHtml(getSubjectObj(normalizeSubjectId(f.subject)).nameEn || getSubjectObj(normalizeSubjectId(f.subject)).nameFr || f.subject)}</td>
                    <td class="mono" style="font-size: 12px;">${formatDate(f.created_at)}</td>
                    <td>
                      <a href="#/voir/${f.id}" class="btn-secondary" style="padding: 4px 10px; font-size: 12px; text-decoration: none;">عرض</a>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  }

  if (isOwner) {
    tabContainer.querySelectorAll(".edit-teacher-btn").forEach(btn => {
      btn.onclick = () => {
        const k = btn.getAttribute("data-kind");
        const sId = btn.getAttribute("data-sub");
        const gNo = parseInt(btn.getAttribute("data-grp"), 10);
        openTeacherEditModal(k, sId, gNo, () => {
          renderGroupDetailView(page, groupNo, tab, subjectId);
        });
      };
    });
  }
}

// 15. OWNER TEACHER EDIT MODAL DIALOG
function openTeacherEditModal(kind, subjectId, groupNo, onSavedCallback) {
  if (!canManageContent()) return;
  if (kind === "cours") groupNo = null; // "cours" teachers are stored with group_no = NULL

  const current = getResolvedTeacher(kind, subjectId, groupNo);
  const subObj = getSubjectObj(subjectId);
  const targetLabel = kind === "cours" ? "المحاضرة (كل الأفواج)" : `الفوج G${groupNo}`;

  const modal = document.createElement("div");
  modal.className = "dialog-overlay";
  modal.innerHTML = `
    <div class="dialog-box">
      <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 6px;">
        تعيين / تعديل أستاذ: ${escapeHtml((subObj.nameEn || subObj.nameFr || subObj.nameAr))} (${kind.toUpperCase()})
      </h3>
      <p style="font-size: 13px; color: var(--muted); margin-bottom: 14px;">
        نطاق التعديل: <strong>${escapeHtml(targetLabel)}</strong>
      </p>

      <div id="teacherEditAlert" class="auth-error-box"></div>

      <form id="teacherEditForm">
        <div class="form-group">
          <label class="form-label" for="teacherEditName">اسم الأستاذ *</label>
          <input type="text" id="teacherEditName" class="form-control" value="${escapeHtml(current.name || '')}" required>
        </div>

        <div class="form-group">
          <label class="form-label" for="teacherEditEmail">البريد الإلكتروني (اختياري)</label>
          <input type="email" id="teacherEditEmail" class="form-control mono" value="${escapeHtml(current.email || '')}" placeholder="teacher@univ.dz">
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 18px; flex-wrap: wrap;">
          <button type="button" class="btn-danger" id="teacherResetBtn" style="padding: 8px 12px;${current.isCustom ? "" : " visibility: hidden;"}">
            حذف الأستاذ
          </button>

          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-secondary" id="teacherCancelBtn">إلغاء</button>
            <button type="submit" class="btn-primary" id="teacherSaveBtn" style="width: auto; min-width: 100px;">حفظ</button>
          </div>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  const form = modal.querySelector("#teacherEditForm");
  const alertBox = modal.querySelector("#teacherEditAlert");
  const cancelBtn = modal.querySelector("#teacherCancelBtn");
  const resetBtn = modal.querySelector("#teacherResetBtn");
  const saveBtn = modal.querySelector("#teacherSaveBtn");

  const closeModal = () => modal.remove();
  cancelBtn.onclick = closeModal;

  form.onsubmit = async (e) => {
    e.preventDefault();
    alertBox.style.display = "none";

    const name = modal.querySelector("#teacherEditName").value.trim();
    const email = modal.querySelector("#teacherEditEmail").value.trim();

    if (!name) {
      alertBox.textContent = "يرجى كتابة اسم الأستاذ.";
      alertBox.style.display = "block";
      return;
    }

    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        alertBox.textContent = "صيغة البريد الإلكتروني غير صحيحة.";
        alertBox.style.display = "block";
        return;
      }
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "جاري الحفظ...";

    try {
      const payload = {
        kind,
        subject_id: subjectId,
        group_no: groupNo, // NULL for cours, 1..10 for td/tp
        name,
        email: email || null,
        updated_at: new Date().toISOString()
      };

      // Find the existing row first (works with NULL group_no), then update or insert.
      let findQ = supabase
        .from("teacher_info")
        .select("id")
        .eq("kind", kind)
        .eq("subject_id", subjectId);
      findQ = groupNo === null ? findQ.is("group_no", null) : findQ.eq("group_no", groupNo);
      const { data: existingRow, error: findErr } = await findQ.maybeSingle();
      if (findErr) throw new Error(findErr.message);

      const { error } = existingRow
        ? await supabase.from("teacher_info").update(payload).eq("id", existingRow.id)
        : await supabase.from("teacher_info").insert(payload);

      if (error) {
        throw new Error(error.message);
      }

      await loadTeacherInfoCache();
      closeModal();
      if (onSavedCallback) onSavedCallback();
    } catch (err) {
      alertBox.textContent = `خطأ: ${err.message}`;
      alertBox.style.display = "block";
      saveBtn.disabled = false;
      saveBtn.textContent = "حفظ";
    }
  };

  resetBtn.onclick = async () => {
    if (!confirm("هل أنت متأكد من حذف هذا الأستاذ من الحصة؟")) return;

    resetBtn.disabled = true;
    resetBtn.textContent = "جاري الحذف...";

    try {
      let delQ = supabase
        .from("teacher_info")
        .delete()
        .eq("kind", kind)
        .eq("subject_id", subjectId);
      delQ = groupNo === null ? delQ.is("group_no", null) : delQ.eq("group_no", groupNo);
      const { error } = await delQ;

      if (error) {
        throw new Error(error.message);
      }

      await loadTeacherInfoCache();
      closeModal();
      if (onSavedCallback) onSavedCallback();
    } catch (err) {
      alertBox.textContent = `خطأ في الحذف: ${err.message}`;
      alertBox.style.display = "block";
      resetBtn.disabled = false;
      resetBtn.textContent = "حذف الأستاذ";
    }
  };
}

// 16. PAGE: LESSON LIST (#/groupe/N/<tab>/<subjectId>)
function renderSubjectLessonsView(page, groupNo, tab, subjectId) {
  const subObj = getSubjectObj(subjectId);
  const teacher = getResolvedTeacher(tab, subjectId, groupNo);
  const isOwner = canManageContent() && ["cours", "td", "tp"].includes(tab);

  let files = state.filesCache.filter(f => {
    const sMatch = normalizeSubjectId(f.subject) === subjectId;
    if (!sMatch) return false;
    if (tab === "cours") {
      return f.kind === "cours" &&
        (isSharedFile(f) || isFileForGroup(f, groupNo));
    }
    return f.kind === tab && isFileForGroup(f, groupNo);
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const tabLabel = tab === "cours" ? "الكور" : tab.toUpperCase();

  page.innerHTML = `
    <div class="breadcrumb">
      <a href="#/groupes">الأفواج</a>
      <span>›</span>
      <a href="#/groupe/${groupNo}" class="mono">G${groupNo}</a>
      <span>›</span>
      <a href="#/groupe/${groupNo}/${tab}">${tabLabel}</a>
      <span>›</span>
      <span class="current">${escapeHtml((subObj.nameEn || subObj.nameFr || subObj.nameAr))}</span>
    </div>

    <div class="page-banner">
      <h2>${escapeHtml((subObj.nameEn || subObj.nameFr || subObj.nameAr))} (<span class="mono">${escapeHtml(subObj.nameFr)}</span>)</h2>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px;">
        <span>الأستاذ المشرف: <strong>${renderTeacherDisplayHtml(teacher)}</strong> · الفوج <span class="mono">G${groupNo}</span></span>
        ${
          isOwner
            ? `<button type="button" class="btn-secondary edit-teacher-btn" data-kind="${tab}" data-sub="${subObj.id}" data-grp="${tab === 'cours' ? 0 : groupNo}" style="padding: 2px 8px; font-size: 11px;">${teacher.name ? "تعديل الأستاذ" : "تعيين الأستاذ"}</button>`
            : ""
        }
      </div>
    </div>

    <div class="content-card">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark);">قائمة الدروس والملفات (<span class="mono">${files.length}</span>)</h3>
        <input type="text" id="lessonSearchInput" class="form-control" placeholder="تصفية الدروس بالعنوان..." style="max-width: 280px; padding: 6px 12px; font-size: 13px;">
      </div>

      <div id="lessonsTableWrapper">
        ${renderLessonsTableHtml(files)}
      </div>
    </div>
  `;

  const searchInput = document.getElementById("lessonSearchInput");
  const wrapper = document.getElementById("lessonsTableWrapper");
  if (searchInput && wrapper) {
    searchInput.oninput = () => {
      const q = searchInput.value.trim().toLowerCase();
      const filtered = files.filter(f => (f.title || "").toLowerCase().includes(q));
      wrapper.innerHTML = renderLessonsTableHtml(filtered);
    };
  }

  if (isOwner) {
    page.querySelectorAll(".edit-teacher-btn").forEach(btn => {
      btn.onclick = () => {
        const k = btn.getAttribute("data-kind");
        const sId = btn.getAttribute("data-sub");
        const gNo = parseInt(btn.getAttribute("data-grp"), 10);
        openTeacherEditModal(k, sId, gNo, () => {
          renderSubjectLessonsView(page, groupNo, tab, subjectId);
        });
      };
    });
  }
}

function renderLessonsTableHtml(filesList) {
  if (filesList.length === 0) {
    return `<div style="text-align: center; padding: 30px; color: var(--muted); font-size: 14px;">ما كاين حتى درس بعد</div>`;
  }
  return `
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 50px;">الرقم</th>
            <th>عنوان الدرس</th>
            <th>تاريخ النشر</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${filesList.map((f, idx) => {
            const isNew = isWithinDays(f.created_at, 7);
            return `
              <tr>
                <td class="mono" style="font-weight: 500;">#${idx + 1}</td>
                <td>
                  <strong>${escapeHtml(f.title)}</strong>
                  ${isNew ? '<span class="badge-new">جديد</span>' : ''}
                </td>
                <td class="mono" style="font-size: 12px;">${formatDate(f.created_at)}</td>
                <td>
                  <a href="#/voir/${f.id}" class="btn-primary" style="padding: 4px 12px; font-size: 12px; width: auto; text-decoration: none;">عرض</a>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// Teacher directory: built from the existing course/group teacher data and overrides.
function collectTeachers() {
  const teachers = new Map();
  const add = (name, kind, subjectId, groupNo) => {
    if (!name) return;
    const slug = teacherSlug(name);
    if (!teachers.has(slug)) teachers.set(slug, { slug, name, assignments: [] });
    const item = teachers.get(slug);
    if (!item.assignments.some(a => a.kind === kind && a.subjectId === subjectId && a.groupNo === groupNo)) {
      item.assignments.push({ kind, subjectId, groupNo });
    }
  };
  for (const sub of SUBJECT_DEFINITIONS) {
    add(getResolvedTeacher("cours", sub.id, 0).name, "cours", sub.id, 0);
    for (let g = 1; g <= 10; g++) {
      add(getResolvedTeacher("td", sub.id, g).name, "td", sub.id, g);
      add(getResolvedTeacher("tp", sub.id, g).name, "tp", sub.id, g);
    }
  }
  return [...teachers.values()].sort((a,b) => a.name.localeCompare(b.name));
}

function teacherKindLabel(kind) {
  return kind === "cours" ? "Cours" : kind === "td" ? "TD" : "TP";
}

function renderTeachersView(page, kindFilter = "all") {
  const teachers = collectTeachers().filter(t => kindFilter === "all" || t.assignments.some(a => a.kind === kindFilter));
  const heading = kindFilter === "all" ? "Teachers Directory" : `${teacherKindLabel(kindFilter)} Teachers`;
  const subjectOptions = SUBJECT_DEFINITIONS.map(sub => `<option value="${escapeHtml(sub.id)}">${escapeHtml(sub.nameEn || sub.nameEn || sub.nameFr || sub.id)}</option>`).join("");
  page.innerHTML = `
    <div class="page-banner"><h2>${heading}</h2><p>Find each teacher, view their subjects, assigned groups, and related study files.</p></div>
    ${canManageContent() ? `
    <div class="content-card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px;">
        <h3 style="margin:0;color:var(--brown-dark);">إدارة الأساتذة</h3>
        <button type="button" class="btn-primary" id="teacherCreateToggle" style="width:auto;padding:9px 16px;">إضافة أستاذ</button>
      </div>
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px;">اضغط «إضافة أستاذ» لفتح النموذج، ثم حدّد المادة ونوع التدريس والفوج عند الحاجة.</p>
      <div id="teacherCreatePanel" style="display:none;">
      <div id="teacherCreateError" class="auth-error-box"></div>
      <div id="teacherCreateSuccess" class="auth-success-box"></div>
      <form id="teacherCreateForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;align-items:end;">
        <div class="form-group" style="margin:0;"><label class="form-label" for="teacherCreateName">اسم الأستاذ *</label><input id="teacherCreateName" class="form-control" required maxlength="120" placeholder="الاسم الكامل"></div>
        <div class="form-group" style="margin:0;"><label class="form-label" for="teacherCreateSubject">المادة *</label><select id="teacherCreateSubject" class="form-control" required>${subjectOptions}</select></div>
        <div class="form-group" style="margin:0;"><label class="form-label" for="teacherCreateKind">نوع التدريس *</label><select id="teacherCreateKind" class="form-control" required><option value="cours">Cours — جميع الأفواج</option><option value="td">TD — فوج محدد</option><option value="tp">TP — فوج محدد</option></select></div>
        <div class="form-group" id="teacherCreateGroupWrap" style="margin:0;display:none;"><label class="form-label" for="teacherCreateGroup">الفوج *</label><select id="teacherCreateGroup" class="form-control">${Array.from({length:10},(_,i)=>`<option value="${i+1}">G${i+1}</option>`).join("")}</select></div>
        <div class="form-group" style="margin:0;"><label class="form-label" for="teacherCreateEmail">البريد الإلكتروني للأستاذ (اختياري)</label><input id="teacherCreateEmail" type="email" class="form-control" placeholder="teacher@univ.dz"></div>
        <button type="submit" class="btn-primary" id="teacherCreateSubmit" style="width:auto;min-height:42px;">حفظ الأستاذ</button>
      </form>
      </div>
    </div>` : ""}
    <div class="content-card">
      <label class="form-label" for="teacherSearchInput">Search teachers</label>
      <input id="teacherSearchInput" class="form-control" type="search" placeholder="Type a teacher name..." autocomplete="off">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;margin-bottom:16px;">
        <a class="btn-secondary" href="#/teachers">All</a><a class="btn-secondary" href="#/teachers/cours">Cours</a><a class="btn-secondary" href="#/teachers/td">TD</a><a class="btn-secondary" href="#/teachers/tp">TP</a>
      </div>
      <div id="teacherDirectoryResults" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;">
        ${teachers.map(t => `<article class="content-card teacher-directory-card" data-name="${escapeHtml(t.name.toLowerCase())}" style="margin:0;padding:16px;"><strong>${escapeHtml(t.name)}</strong><p style="color:var(--muted);font-size:12px;margin:8px 0;">${[...new Set(t.assignments.filter(a => kindFilter === "all" || a.kind === kindFilter).map(a => teacherKindLabel(a.kind)))].join(" · ")}</p><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;"><a href="#/teacher/${encodeURIComponent(t.slug)}" class="btn-primary" style="display:inline-block;width:auto;text-decoration:none;">View teacher & files</a>${canManageContent() ? `<button type="button" class="btn-secondary teacher-delete-btn" data-teacher-name="${escapeHtml(t.name)}" style="width:auto;">حذف الأستاذ</button>` : ""}</div></article>`).join("")}
      </div>
      ${teachers.length ? "" : `<p style="color:var(--muted);text-align:center;padding:20px;">No teachers have been added to this category yet.</p>`}
    </div>`;
  const input = page.querySelector("#teacherSearchInput");
  input?.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    page.querySelectorAll(".teacher-directory-card").forEach(card => { card.style.display = card.dataset.name.includes(q) ? "" : "none"; });
  });
  // Deletes teacher assignment rows only; related course files are not deleted.
  page.querySelectorAll(".teacher-delete-btn").forEach(button => {
    button.addEventListener("click", async () => {
      if (!canManageContent()) {
        alert("ليست لديك صلاحية حذف الأساتذة.");
        return;
      }

      const teacherName = button.dataset.teacherName;
      if (!teacherName) return;

      const confirmed = confirm(
        `هل تريد حذف الأستاذ "${teacherName}"؟\nسيتم حذف جميع تعييناته (Cours/TD/TP) المسجلة بهذا الاسم، ولن تُحذف ملفات المواد.`
      );
      if (!confirmed) return;

      button.disabled = true;
      button.textContent = "جارٍ الحذف...";

      try {
        const { error } = await supabase
          .from("teacher_info")
          .delete()
          .eq("name", teacherName);

        if (error) throw error;

        await loadTeacherInfoCache();
        renderTeachersView(page, kindFilter);
      } catch (error) {
        console.error("Delete teacher failed:", error);
        alert(`تعذر حذف الأستاذ: ${error?.message || "خطأ غير معروف"}`);
        button.disabled = false;
        button.textContent = "حذف الأستاذ";
      }
    });
  });

  const createToggle = page.querySelector("#teacherCreateToggle");
  const createPanel = page.querySelector("#teacherCreatePanel");
  createToggle?.addEventListener("click", () => {
    const willOpen = createPanel.style.display === "none";
    createPanel.style.display = willOpen ? "block" : "none";
    createToggle.textContent = willOpen ? "إغلاق نموذج الإضافة" : "إضافة أستاذ";
    if (willOpen) page.querySelector("#teacherCreateName")?.focus();
  });

  const createForm = page.querySelector("#teacherCreateForm");
  if (createForm) {
    const kindSelect = page.querySelector("#teacherCreateKind");
    const groupWrap = page.querySelector("#teacherCreateGroupWrap");
    const updateGroupVisibility = () => { groupWrap.style.display = kindSelect.value === "cours" ? "none" : "block"; };
    kindSelect.addEventListener("change", updateGroupVisibility);
    updateGroupVisibility();
    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const errorBox = page.querySelector("#teacherCreateError");
      const successBox = page.querySelector("#teacherCreateSuccess");
      const submit = page.querySelector("#teacherCreateSubmit");
      errorBox.style.display = "none"; successBox.style.display = "none";
      if (!canManageContent()) { errorBox.textContent = "Only the owner or an authorized administrator can manage teachers."; errorBox.style.display = "block"; return; }
      const name = page.querySelector("#teacherCreateName").value.trim();
      const email = page.querySelector("#teacherCreateEmail").value.trim();
      const kind = kindSelect.value;
      const subjectId = page.querySelector("#teacherCreateSubject").value;
      const groupNo = kind === "cours" ? null : Number(page.querySelector("#teacherCreateGroup").value);
      if (!name || !subjectId || !["cours","td","tp"].includes(kind) || (kind !== "cours" && !(groupNo >= 1 && groupNo <= 10))) {
        errorBox.textContent = "Please complete the teacher, subject, type, and group fields."; errorBox.style.display = "block"; return;
      }
      submit.disabled = true; submit.textContent = "جارٍ الحفظ...";
      try {
        let query = supabase.from("teacher_info").select("id").eq("kind",kind).eq("subject_id",subjectId);
        query = groupNo === null ? query.is("group_no",null) : query.eq("group_no",groupNo);
        const {data: existing,error: lookupError} = await query.maybeSingle();
        if (lookupError) throw new Error(lookupError.message);
        const payload = {kind,subject_id:subjectId,group_no:groupNo,name,email:email || null,updated_at:new Date().toISOString()};
        const result = existing
          ? await supabase.from("teacher_info").update(payload).eq("id",existing.id)
          : await supabase.from("teacher_info").insert(payload);
        if (result.error) throw new Error(result.error.message);
        await loadTeacherInfoCache();
        successBox.textContent = `Saved ${name} — ${kind.toUpperCase()} — ${getSubjectObj(subjectId).nameEn || getSubjectObj(subjectId).nameFr || subjectId}${kind === "cours" ? " — all groups" : ` — G${groupNo}`}.`;
        successBox.style.display = "block";
        page.querySelector("#teacherCreateName").value = "";
        page.querySelector("#teacherCreateEmail").value = "";
        renderTeachersView(page, kindFilter);
      } catch (err) {
        errorBox.textContent = `تعذر حفظ الأستاذ: ${err.message}`;
        errorBox.style.display = "block";
      } finally {
        const currentSubmit = page.querySelector("#teacherCreateSubmit");
        if (currentSubmit) { currentSubmit.disabled = false; currentSubmit.textContent = "حفظ الأستاذ"; }
      }
    });
  }
}

function renderTeacherProfileView(page, slug) {
  const teacher = collectTeachers().find(t => t.slug === slug);
  if (!teacher) { renderNotFoundView(page); return; }
  const assignments = teacher.assignments;
  const accessibleFiles = getAccessibleFiles();
  const subjectIds = [...new Set(assignments.map(a => a.subjectId))];
  // The files schema links files to subjects/groups, not directly to teacher IDs.
  // Show accessible files for the subjects and assignment types this teacher teaches.
  const relatedFiles = accessibleFiles.filter(f => {
    const sid = normalizeSubjectId(f.subject);
    if (!subjectIds.includes(sid)) return false;
    return assignments.some(a => a.subjectId === sid && (a.kind === "cours" ? f.kind === "cours" : a.kind === f.kind && (f.group_no == null || f.group_no === a.groupNo)));
  });
  page.innerHTML = `
    <div class="breadcrumb"><a href="#/teachers">الأساتذة</a><span>›</span><span>${escapeHtml(teacher.name)}</span></div>
    <div class="page-banner"><h2>${escapeHtml(teacher.name)}</h2><p>المواد والأفواج والملفات المرتبطة بتدريس هذا الأستاذ وفق البيانات المتاحة.</p></div>
    <div class="content-card"><h3 style="margin-bottom:12px;">المواد والأفواج</h3>
      <div class="table-responsive"><table class="data-table"><thead><tr><th>Teaching Type</th><th>Subject</th><th>Group</th><th>Action</th></tr></thead><tbody>
      ${assignments.map(a => { const sub = getSubjectObj(a.subjectId); return `<tr><td>${teacherKindLabel(a.kind)}</td><td>${escapeHtml(sub.nameEn || sub.nameEn || sub.nameFr || sub.id)}</td><td>${a.kind === "cours" ? "All groups (G1–G10)" : `G${a.groupNo}`}</td><td><a class="btn-secondary" style="text-decoration:none;padding:4px 8px;" href="#/groupe/${a.kind === "cours" ? (state.studentGroup || 1) : a.groupNo}/${a.kind}/${a.subjectId}">View subject</a></td></tr>`; }).join("")}
      </tbody></table></div>
    </div>
    <div class="content-card"><h3 style="margin-bottom:12px;">Available Files (${relatedFiles.length})</h3>
      ${relatedFiles.length ? `<div class="table-responsive"><table class="data-table"><thead><tr><th>File Title</th><th>Subject</th><th>Type</th><th>Group</th><th>Action</th></tr></thead><tbody>${relatedFiles.map(f => `<tr><td>${escapeHtml(f.title)}</td><td>${escapeHtml(getSubjectObj(normalizeSubjectId(f.subject)).nameEn || getSubjectObj(normalizeSubjectId(f.subject)).nameFr || f.subject)}</td><td>${escapeHtml(teacherKindLabel(f.kind))}</td><td>${f.group_no ? `G${f.group_no}` : "كل الأفواج"}</td><td><a class="btn-secondary" style="text-decoration:none;padding:4px 8px;" href="#/voir/${encodeURIComponent(f.id)}">Open file</a></td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);text-align:center;padding:18px;">No accessible files are linked to this teacher yet. Files appear here when uploaded under the matching subject, type, and group.</p>`}
    </div>`;
}

// 17. PAGE: TIMETABLE (#/horaire)
// The timetable is a PDF program per group. This intentionally no longer reads
// schedule_entries, whose legacy columns caused day_of_week/start_time schema errors.
function renderTimetableView(page) {
  const role = state.role;
  const isOwnerAdmin = role === "owner" || role === "admin";
  const isUploader = role === "uploader";
  const canUpload = isOwnerAdmin || isUploader;
  const ownGroup = isUploader ? Number(state.uploaderGroup) : Number(state.studentGroup);
  let selectedGroup = isOwnerAdmin ? String(state.studentGroup || 1) : String(ownGroup || 1);

  const groupOptions = [1,2,3,4,5,6,7,8,9,10]
    .map(g => `<option value="${g}" ${String(g) === selectedGroup ? "selected" : ""}>الفوج ${g}</option>`)
    .join("");

  page.innerHTML = `
    <div class="page-banner">
      <h2>البرنامج الدراسي (PDF)</h2>
      <p>تصفّح البرنامج الدراسي الكامل بصيغة PDF بدل إدخال الحصص يدويًا.</p>
    </div>

    <div class="content-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
        <div style="min-width:220px;">
          <label class="form-label" for="programGroupSelect">عرض برنامج الفوج</label>
          <select id="programGroupSelect" class="form-control mono" style="max-width:260px;" ${!isOwnerAdmin ? "disabled" : ""}>
            ${isOwnerAdmin ? `<option value="all">جميع الأفواج</option>` : ""}
            ${groupOptions}
          </select>
        </div>
      </div>

      ${canUpload ? `
        <div style="border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:18px;background:var(--cream,#fbf7f0);">
          <h3 style="font-size:16px;font-weight:700;color:var(--brown-dark);margin-bottom:6px;">إضافة البرنامج PDF</h3>
          <p style="font-size:13px;color:var(--muted);line-height:1.8;margin-bottom:14px;">ارفع ملف PDF الذي يحتوي على البرنامج الدراسي كاملًا. رئيس القسم يستطيع رفع برنامج فوجه فقط؛ أما المالك والمشرف فيمكنهما اختيار الفوج المستهدف.</p>
          <div id="programUploadError" class="auth-error-box" role="alert"></div>
          <div id="programUploadSuccess" class="auth-success-box" role="status"></div>
          <form id="programUploadForm" style="display:grid;gap:12px;">
            <div class="form-group" style="margin:0;">
              <label class="form-label" for="programTitle">عنوان البرنامج *</label>
              <input id="programTitle" class="form-control" maxlength="160" required placeholder="مثال: البرنامج الدراسي — السداسي الأول">
            </div>
            ${isOwnerAdmin ? `
              <div class="form-group" style="margin:0;">
                <label class="form-label" for="programUploadGroup">الفوج المستهدف *</label>
                <select id="programUploadGroup" class="form-control mono" required>
                  <option value="all">جميع الأفواج (برنامج مشترك)</option>
                  ${[1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}" ${g === Number(state.studentGroup || 1) ? "selected" : ""}>الفوج ${g}</option>`).join("")}
                </select>
              </div>` : `
              <div class="form-group" style="margin:0;">
                <label class="form-label">الفوج المسموح لك بإدارته</label>
                <input class="form-control mono" value="الفوج ${ownGroup || "غير محدد"}" disabled>
              </div>`}
            <div class="form-group" style="margin:0;">
              <label class="form-label" for="programPdfFile">ملف البرنامج PDF (حتى 25 ميغابايت) *</label>
              <input id="programPdfFile" class="form-control" type="file" accept=".pdf,application/pdf" required>
            </div>
            <button type="submit" class="btn-primary" id="programUploadSubmit" style="width:auto;justify-self:start;padding:10px 18px;">إضافة البرنامج PDF</button>
          </form>
        </div>
      ` : ""}

      <div id="programFilesList"></div>
    </div>
  `;

  const groupSelect = page.querySelector("#programGroupSelect");
  const renderPrograms = () => {
    const list = page.querySelector("#programFilesList");
    if (!list) return;
    if (!isOwnerAdmin && !ownGroup) {
      list.innerHTML = `<div class="content-card"><p style="color:var(--muted);line-height:1.8;">لم يُعيّن فوجك الدراسي بعد. يرجى التواصل مع إدارة المنصة لتعيين فوجك.</p></div>`;
      return;
    }
    const value = groupSelect?.value || selectedGroup;
    const programs = state.filesCache
      .filter(file => isScheduleProgramFile(file))
      .filter(file => value === "all" ? true : isFileForGroup(file, Number(value)))
      .sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    if (!programs.length) {
      list.innerHTML = `<div style="text-align:center;padding:28px;color:var(--muted);">لم يُرفع البرنامج الدراسي لهذا الاختيار بعد.</div>`;
      return;
    }
    list.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr><th>البرنامج</th><th>الفوج</th><th>تاريخ الإضافة</th><th>Action</th></tr></thead>
          <tbody>${programs.map(file => {
            const group = getFileGroupNo(file);
            const groupLabel = group ? `الفوج ${group}` : "جميع الأفواج";
            return `<tr>
              <td><strong>${escapeHtml(file.title || "البرنامج الدراسي")}</strong></td>
              <td class="mono">${groupLabel}</td>
              <td class="mono" style="font-size:12px;">${formatDate(file.created_at)}</td>
              <td><a href="#/voir/${encodeURIComponent(file.id)}" class="btn-primary" style="display:inline-block;width:auto;text-decoration:none;padding:5px 12px;">معاينة PDF</a></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>`;
  };

  if (groupSelect) {
    groupSelect.onchange = renderPrograms;
  }
  renderPrograms();

  const form = page.querySelector("#programUploadForm");
  if (form) {
    form.onsubmit = async event => {
      event.preventDefault();
      const errorBox = page.querySelector("#programUploadError");
      const successBox = page.querySelector("#programUploadSuccess");
      const button = page.querySelector("#programUploadSubmit");
      errorBox.style.display = "none";
      successBox.style.display = "none";

      const title = page.querySelector("#programTitle").value.trim();
      const file = page.querySelector("#programPdfFile").files?.[0];
      const targetValue = isOwnerAdmin ? page.querySelector("#programUploadGroup").value : String(ownGroup);
      if (!canUpload || (isUploader && (!ownGroup || ownGroup < 1 || ownGroup > 10))) {
        errorBox.textContent = "لا تملك صلاحية رفع البرنامج لهذا الفوج.";
        errorBox.style.display = "block";
        return;
      }
      if (!title) {
        errorBox.textContent = "اكتب عنوان البرنامج أولًا.";
        errorBox.style.display = "block";
        return;
      }
      if (!file || (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf")) {
        errorBox.textContent = "اختر ملفًا بصيغة PDF.";
        errorBox.style.display = "block";
        return;
      }
      if (file.size > 25 * 1024 * 1024) {
        errorBox.textContent = "حجم الملف يتجاوز 25 ميغابايت.";
        errorBox.style.display = "block";
        return;
      }

      const targetGroup = targetValue === "all" ? null : Number(targetValue);
      if (targetGroup !== null && (!Number.isInteger(targetGroup) || targetGroup < 1 || targetGroup > 10)) {
        errorBox.textContent = "اختر فوجًا صحيحًا من 1 إلى 10.";
        errorBox.style.display = "block";
        return;
      }

      button.disabled = true;
      button.textContent = "جارٍ رفع البرنامج...";
      const folder = targetGroup === null ? "common" : `g${targetGroup}`;
      const storagePath = `${folder}/schedule_${Date.now()}_${Math.random().toString(36).slice(2,8)}.pdf`;
      let uploaded = false;
      try {
        const { error: storageError } = await supabase.storage
          .from("course-files")
          .upload(storagePath, file, { cacheControl: "3600", upsert: false, contentType: "application/pdf" });
        if (storageError) throw new Error(storageError.message);
        uploaded = true;

        const { error: insertError } = await supabase.from("files").insert({
          title,
          semester: "S1",
          subject: SCHEDULE_PDF_SUBJECT,
          kind: "autre",
          group_no: targetGroup,
          path: storagePath
        });
        if (insertError) throw new Error(insertError.message);

        successBox.textContent = "تم رفع البرنامج وحفظه بنجاح.";
        successBox.style.display = "block";
        form.reset();
        await loadFilesCache();
        renderTimetableView(page);
      } catch (error) {
        if (uploaded) {
          const { error: cleanupError } = await supabase.storage.from("course-files").remove([storagePath]);
          if (cleanupError) console.warn("Could not clean up failed schedule PDF upload:", cleanupError.message);
        }
        errorBox.textContent = `تعذر رفع البرنامج: ${error.message || "حدث خطأ غير متوقع"}`;
        errorBox.style.display = "block";
      } finally {
        const currentButton = page.querySelector("#programUploadSubmit");
        if (currentButton) {
          currentButton.disabled = false;
          currentButton.textContent = "إضافة البرنامج PDF";
        }
      }
    };
  }
}

// 18. PAGE: VIEW-ONLY PDF VIEWER (#/voir/:id)
async function renderPdfViewerView(page, fileId) {
  let fileObj = state.filesCache.find(f => String(f.id) === String(fileId));
  if (!fileObj) {
    const { data } = await supabase.from("files").select("*").eq("id", fileId).single();
    if (data) {
      fileObj = data;
    }
  }

  if (!fileObj) {
    page.innerHTML = `
      <div class="content-card" style="text-align: center; padding: 40px;">
        <h2 style="font-size: 18px; color: var(--danger); margin-bottom: 8px;">الملف غير موجود</h2>
        <a href="#/" class="btn-primary" style="display: inline-block; width: auto;">العودة للرئيسية</a>
      </div>
    `;
    return;
  }

  page.innerHTML = `
    <div class="breadcrumb">
      <a href="#/">الرئيسية</a>
      <span>›</span>
      <span class="current">${escapeHtml(fileObj.title)}</span>
    </div>

    <div class="pdf-viewer-wrap" id="pdfViewerContainer" oncontextmenu="return false;">
      <div class="pdf-viewer-toolbar">
        <div class="pdf-toolbar-group">
          <strong>${escapeHtml(fileObj.title)}</strong>
          <span class="badge-tag mono" style="margin-right: 8px;">${escapeHtml(fileObj.subject)}</span>
        </div>

        <div class="pdf-toolbar-group">
          <button type="button" class="btn-secondary" id="pdfPrevPage" style="padding: 4px 10px;">السابق</button>
          <span style="font-size: 13px;" class="mono" id="pdfPageIndicator">صفحة 1 / 1</span>
          <button type="button" class="btn-secondary" id="pdfNextPage" style="padding: 4px 10px;">التالي</button>

          <span style="border-right: 1px solid var(--line); height: 20px; margin: 0 4px;"></span>

          <button type="button" class="btn-secondary mono" id="pdfZoomOut" title="تصغير" aria-label="تصغير" style="padding: 4px 10px;">−</button>
          <span style="font-size: 12px; min-width: 42px; text-align:center;" class="mono" id="pdfZoomLevel">100%</span>
          <button type="button" class="btn-secondary mono" id="pdfZoomIn" title="تكبير" aria-label="تكبير" style="padding: 4px 10px;">+</button>
          <button type="button" class="btn-secondary" id="pdfZoomReset" style="padding: 4px 10px;">الحجم الطبيعي</button>
          <button type="button" class="btn-secondary" id="pdfFitWidth" style="padding: 4px 10px;">ملاءمة العرض</button>
          <button type="button" class="btn-primary" id="pdfDownloadFile" style="padding: 6px 12px;" aria-label="تحميل ملف الدرس">تحميل الملف</button>
        </div>
      </div>

      <div class="pdf-canvas-container" id="pdfCanvasContainer">
        <div id="pdfLoadingState" style="color: #ffffff; padding: 40px; text-align: center;">جاري تحميل الملف...</div>
        <canvas id="pdfCanvas" style="display: none;"></canvas>
        <div id="pdfErrorState" style="display: none; color: #fca5a5; padding: 30px; text-align: center;"></div>
      </div>

      <div class="pdf-viewer-footer-note">
        يمكنك معاينة الملف أو تحميله للدراسة.
      </div>
    </div>
  `;

  const container = document.getElementById("pdfViewerContainer");
  if (container) {
    container.addEventListener("contextmenu", e => e.preventDefault());
  }

  // Download using a short-lived signed URL. Storage RLS remains the authority:
  // students can download only files they are already allowed to read.
  const downloadButton = document.getElementById("pdfDownloadFile");
  if (downloadButton) {
    downloadButton.addEventListener("click", async () => {
      const originalLabel = downloadButton.textContent;
      downloadButton.disabled = true;
      downloadButton.textContent = "جاري تجهيز التحميل...";
      try {
        let downloadName = String(fileObj.title || "lesson").trim();
        downloadName = downloadName.replace(/[\\\\/:*?"<>|\\u0000-\\u001f]/g, "_").slice(0, 140) || "lesson";
        if (!/\\.pdf$/i.test(downloadName)) downloadName += ".pdf";

        const { data, error } = await supabase.storage
          .from("course-files")
          .createSignedUrl(fileObj.path, 300, { download: downloadName });

        if (error || !data?.signedUrl) {
          throw new Error(error?.message || "تعذر إنشاء رابط التحميل.");
        }
        window.location.assign(data.signedUrl);
      } catch (err) {
        alert(`تعذر تحميل الملف: ${err.message || "حدث خطأ غير متوقع"}`);
      } finally {
        downloadButton.disabled = false;
        downloadButton.textContent = originalLabel;
      }
    });
  }

  try {
    const { data: signedData, error: signedError } = await supabase.storage
      .from("course-files")
      .createSignedUrl(fileObj.path, 300);

    if (signedError || !signedData?.signedUrl) {
      throw new Error(signedError?.message || "فشل الحصول على رابط آمن لعرض الملف.");
    }

    loadPdfWithPdfJs(signedData.signedUrl);
  } catch (err) {
    showPdfError(err.message || "تعذر فتح المستند.");
  }
}

function showPdfError(msg) {
  const loading = document.getElementById("pdfLoadingState");
  const errBox = document.getElementById("pdfErrorState");
  if (loading) loading.style.display = "none";
  if (errBox) {
    errBox.innerHTML = `خطأ في المعاينة: ${escapeHtml(msg)}<br><small>لا يمكن تحميل الملف مباشرة لأسباب أمنية.</small>`;
    errBox.style.display = "block";
  }
}

async function loadPdfWithPdfJs(pdfUrl) {
  // Canvas renderer built on PDF.js, tuned for Arabic documents.
  // Why this fixes "stuck letters" for every file (current and future):
  //  1) Pages are drawn at 2x-3x pixel density (devicePixelRatio aware). A 1x canvas
  //     blurs thin Arabic strokes and dots until letters look glued together.
  //  2) cMaps + standard fonts are loaded, so PDFs whose fonts are NOT embedded
  //     still get correct glyph mapping instead of a broken fallback.
  //  3) The same code path is used for every PDF, so nothing depends on one file.
  // If PDF.js cannot load at all, we fall back to the browser's native viewer.
  const loading = document.getElementById("pdfLoadingState");
  const container = document.getElementById("pdfCanvasContainer");
  if (!container) return;

  if (!window.pdfjsLib) {
    loadPdfNativeFallback(pdfUrl);
    return;
  }

  const PDFJS_ASSETS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/";
  let pdfDoc;
  try {
    pdfDoc = await window.pdfjsLib.getDocument({
      url: pdfUrl,
      cMapUrl: PDFJS_ASSETS + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: PDFJS_ASSETS + "standard_fonts/",
      useSystemFonts: true,
      isEvalSupported: false
    }).promise;
  } catch (err) {
    console.warn("PDF.js failed, using native viewer:", err);
    loadPdfNativeFallback(pdfUrl);
    return;
  }

  // Layout: LTR scroll container (avoids RTL scroll quirks), centred page column.
  container.innerHTML = "";
  container.style.direction = "ltr";
  container.style.alignItems = "stretch";
  const pagesBox = document.createElement("div");
  pagesBox.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:14px;width:max-content;min-width:100%;";
  container.appendChild(pagesBox);

  const total = pdfDoc.numPages;
  let zoom = 1;               // 1 = fit width
  let renderToken = 0;
  let observer = null;
  let pageEls = [];
  let selectedPageNumber = 1;
  let lastWidth = container.clientWidth;

  const indicator = document.getElementById("pdfPageIndicator");
  const zoomLabel = document.getElementById("pdfZoomLevel");
  const updateIndicator = (n) => { if (indicator) indicator.textContent = `صفحة ${n} / ${total}`; };

  function availableWidth() {
    const cs = getComputedStyle(container);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return Math.max(200, container.clientWidth - pad);
  }

  async function renderPage(entry, token) {
    if (entry.rendered || token !== renderToken) return;
    entry.rendered = true;
    try {
      const page = await pdfDoc.getPage(entry.num);
      if (token !== renderToken) return;
      const viewport = page.getViewport({ scale: entry.cssScale });
      // Sharpness: at least 2x, up to 3x; capped so mobile browsers keep the canvas.
      let outScale = Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2);
      const maxPixels = 10000000;
      while (viewport.width * viewport.height * outScale * outScale > maxPixels && outScale > 1) {
        outScale -= 0.25;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * outScale);
      canvas.height = Math.floor(viewport.height * outScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.style.display = "block";
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx,
        viewport,
        transform: [outScale, 0, 0, outScale, 0, 0]
      }).promise;
      if (token !== renderToken) return;
      entry.el.innerHTML = "";
      entry.el.appendChild(canvas);
    } catch (err) {
      entry.rendered = false;
      console.warn("Page render failed:", entry.num, err);
    }
  }

  async function layout() {
    const token = ++renderToken;
    if (observer) observer.disconnect();
    pagesBox.innerHTML = "";
    pageEls = [];

    const first = await pdfDoc.getPage(1);
    if (token !== renderToken) return;
    const baseWidth = first.getViewport({ scale: 1 }).width;
    const cssScale = (availableWidth() / baseWidth) * zoom;

    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const entry = pageEls[Number(e.target.dataset.index)];
          if (entry) renderPage(entry, token);
        }
      }
    }, { root: container, rootMargin: "800px 0px" });

    // Paint the first page immediately; fetch the remaining page dimensions in parallel
    // so opening a long PDF does not wait for every page sequentially.
    const firstVp = first.getViewport({ scale: cssScale });
    const firstEl = document.createElement("div");
    firstEl.dataset.index = "0";
    firstEl.style.cssText = `width:${Math.floor(firstVp.width)}px;height:${Math.floor(firstVp.height)}px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.18);flex:0 0 auto;`;
    pagesBox.appendChild(firstEl);
    pageEls.push({ num: 1, el: firstEl, cssScale, rendered: false });
    observer.observe(firstEl);
    renderPage(pageEls[0], token);
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    updateIndicator(1);

    Promise.all(Array.from({ length: Math.max(0, total - 1) }, (_, i) => pdfDoc.getPage(i + 2)))
      .then((remainingPages) => {
        if (token !== renderToken) return;
        remainingPages.forEach((page, i) => {
          const n = i + 2;
          const vp = page.getViewport({ scale: cssScale });
          const el = document.createElement("div");
          el.dataset.index = String(n - 1);
          el.style.cssText = `width:${Math.floor(vp.width)}px;height:${Math.floor(vp.height)}px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.18);flex:0 0 auto;`;
          pagesBox.appendChild(el);
          const entry = { num: n, el, cssScale, rendered: false };
          pageEls.push(entry);
          observer.observe(el);
        });
      })
      .catch((err) => console.warn("Some PDF pages are taking longer to load:", err));
  }

  function currentPage() {
    const top = container.getBoundingClientRect().top;
    let best = 1, bestDist = Infinity;
    for (const entry of pageEls) {
      const d = Math.abs(entry.el.getBoundingClientRect().top - top - 20);
      if (d < bestDist) { bestDist = d; best = entry.num; }
    }
    return best;
  }

  const goTo = (n) => {
    const entry = pageEls[Math.max(1, Math.min(total, n)) - 1];
    if (entry) {
      selectedPageNumber = entry.num;
      updateIndicator(selectedPageNumber);
      container.scrollTo({ top: entry.el.offsetTop - 10, behavior: "smooth" });
    }
  };

  container.addEventListener("scroll", () => {
    selectedPageNumber = currentPage();
    updateIndicator(selectedPageNumber);
  }, { passive: true });
  document.getElementById("pdfPrevPage").onclick = () => goTo(selectedPageNumber - 1);
  document.getElementById("pdfNextPage").onclick = () => goTo(selectedPageNumber + 1);
  document.getElementById("pdfZoomIn").onclick = () => { zoom = Math.min(3, +(zoom + 0.25).toFixed(2)); layout(); };
  document.getElementById("pdfZoomOut").onclick = () => { zoom = Math.max(0.5, +(zoom - 0.25).toFixed(2)); layout(); };
  document.getElementById("pdfZoomReset").onclick = () => { zoom = 1; layout(); };
  document.getElementById("pdfFitWidth").onclick = () => { zoom = 1; layout(); };

  // Re-fit when the window width really changes (rotation, resize).
  let resizeTimer = null;
  const onResize = () => {
    if (!document.body.contains(container)) { window.removeEventListener("resize", onResize); return; }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(container.clientWidth - lastWidth) > 4) {
        lastWidth = container.clientWidth;
        layout();
      }
    }, 250);
  };
  window.addEventListener("resize", onResize);

  if (loading) loading.style.display = "none";
  await layout();
}

function loadPdfNativeFallback(pdfUrl) {
  // Last-resort viewer: the browser's built-in PDF viewer.
  const loading = document.getElementById("pdfLoadingState");
  const container = document.getElementById("pdfCanvasContainer");
  if (!container) return;
  let zoom = 100;
  container.innerHTML = `
    <iframe id="nativePdfFrame" title="معاينة ملف PDF"
      style="display:block;width:100%;height:78vh;min-height:520px;border:0;background:#fff;"
      referrerpolicy="no-referrer"></iframe>`;
  const frame = document.getElementById("nativePdfFrame");
  const setZoom = (value) => {
    zoom = Math.max(40, Math.min(300, value));
    const label = document.getElementById("pdfZoomLevel");
    if (label) label.textContent = `${zoom}%`;
    frame.src = `${pdfUrl}#toolbar=0&navpanes=0&scrollbar=1&zoom=${zoom}`;
  };
  document.getElementById("pdfZoomIn").onclick = () => setZoom(zoom + 20);
  document.getElementById("pdfZoomOut").onclick = () => setZoom(zoom - 20);
  document.getElementById("pdfZoomReset").onclick = () => setZoom(100);
  document.getElementById("pdfFitWidth").onclick = () => setZoom(100);
  for (const id of ["pdfPrevPage", "pdfNextPage", "pdfPageIndicator"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  if (loading) loading.style.display = "none";
  setZoom(100);
}

// Owner-only directory. Suspension actions are performed by a Supabase Edge Function;
// the service-role key is never placed in browser code.
async function renderOwnerUsersView(page) {
  if (state.role !== "owner") {
    renderAccessDenied(page);
    return;
  }
  page.innerHTML = `
    <div class="page-banner">
      <h2>لوحة المالك — إدارة المستخدمين</h2>
      <p>قائمة خاصة بالمالك تضم الطلاب والمشرفين ورؤساء الأقسام، مصنفة حسب الفوج والدور.</p>
    </div>
    <div class="content-card">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px;">
        <div class="form-group" style="margin:0;">
          <label class="form-label" for="ownerUserGroupFilter">الفوج</label>
          <select id="ownerUserGroupFilter" class="form-control mono">
            <option value="all">جميع الأفواج</option>
            ${[1,2,3,4,5,6,7,8,9,10].map(g=>`<option value="${g}">الفوج ${g}</option>`).join("")}
          </select>
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" for="ownerUserRoleFilter">نوع الحساب</label>
          <select id="ownerUserRoleFilter" class="form-control">
            <option value="all">جميع الأدوار</option>
            <option value="student">الطلاب</option>
            <option value="uploader">رؤساء الأقسام</option>
            <option value="admin">المشرفون</option>
            <option value="owner">المالك</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" for="ownerUserSearch">بحث بالبريد الإلكتروني</label>
          <input id="ownerUserSearch" class="form-control" type="search" placeholder="اكتب البريد الإلكتروني">
        </div>
      </div>
      <div id="ownerUsersNotice" role="status" class="auth-success-box" style="display:none;"></div>
      <div id="ownerUsersError" role="alert" class="auth-error-box" style="display:none;"></div>
      <div id="ownerUsersTable"><p style="padding:18px;color:var(--muted);">جارٍ تحميل قائمة المستخدمين...</p></div>
    </div>
    <div class="content-card" style="margin-top:18px;">
      <h3 style="font-size:18px;color:var(--brown-dark);margin-bottom:6px;">طلبات حذف الحسابات</h3>
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">طلبات الطلاب فقط. يمكنك مراجعة الطلب ثم حذف الحساب نهائيًا؛ حسابات المالك والمشرفين ورؤساء الأقسام محمية.</p>
      <div id="ownerDeletionRequests"><p style="color:var(--muted);">جارٍ تحميل الطلبات...</p></div>
    </div>
    <div class="content-card" style="margin-top:18px;">
      <h3 style="font-size:18px;color:var(--brown-dark);margin-bottom:6px;">طلبات أسماء الطلاب</h3>
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">راجع الاسم الذي أرسله الطالب، ثم وافق عليه ليظهر في الموقع أو ارفض الطلب.</p>
      <div id="ownerStudentNameRequests"><p style="color:var(--muted);">جارٍ تحميل طلبات الأسماء...</p></div>
    </div>
  `;

  const groupFilter = page.querySelector("#ownerUserGroupFilter");
  const roleFilter = page.querySelector("#ownerUserRoleFilter");
  const searchInput = page.querySelector("#ownerUserSearch");
  const table = page.querySelector("#ownerUsersTable");
  const errorBox = page.querySelector("#ownerUsersError");
  const noticeBox = page.querySelector("#ownerUsersNotice");
  let users = [];
  const roleLabels = { owner: "المالك", admin: "مشرف عام", uploader: "رئيس قسم", student: "طالب" };

  function renderRows() {
    const group = groupFilter.value;
    const role = roleFilter.value;
    const query = searchInput.value.trim().toLowerCase();
    const filtered = users.filter(user => {
      const userRole = listedUserRole(user);
      const userGroup = listedUserGroup(user);
      return (group === "all" || String(userGroup || "") === group)
        && (role === "all" || userRole === role)
        && String(user.email || "").toLowerCase().includes(query);
    });

    if (!filtered.length) {
      table.innerHTML = `<p style="padding:20px;text-align:center;color:var(--muted);">لا توجد حسابات مطابقة لهذه الاختيارات.</p>`;
      return;
    }
    table.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr><th>البريد الإلكتروني</th><th>الدور</th><th>الفوج</th><th>الحالة</th><th>الإجراء</th></tr></thead>
          <tbody>${filtered.map(user => {
            const userId = listedUserId(user);
            const userRole = listedUserRole(user);
            const userGroup = listedUserGroup(user);
            const suspended = user.is_suspended === true || user.suspended === true;
            const isProtectedOwner = userRole === "owner" || String(user.email || "").toLowerCase() === "locoviber16@gmail.com";
            return `<tr>
              <td class="mono">${escapeHtml(user.email || "—")}</td>
              <td>${roleLabels[userRole] || escapeHtml(userRole)}</td>
              <td class="mono">${userGroup ? `G${userGroup}` : (userRole === "owner" || userRole === "admin" ? "كل الأفواج" : "غير محدد")}</td>
              <td><span style="font-weight:600;color:${suspended ? "var(--danger)" : "var(--success,#28734a)"};">${suspended ? "موقوف" : "نشط"}</span></td>
              <td>${isProtectedOwner ? `<span style="color:var(--muted);">محمي</span>` : `<div style="display:flex;gap:6px;flex-wrap:wrap;"><button type="button" class="${suspended ? "btn-primary" : "btn-danger"} owner-user-access-btn" data-user-id="${escapeHtml(userId || "")}" data-action="${suspended ? "restore" : "suspend"}" data-email="${escapeHtml(user.email || "")}" ${!userId ? "disabled" : ""}>${suspended ? "إعادة التفعيل" : "إيقاف الحساب"}</button>${userRole === "student" ? `<button type="button" class="btn-danger owner-delete-student-btn" data-user-id="${escapeHtml(userId || "")}" data-email="${escapeHtml(user.email || "")}" ${!userId ? "disabled" : ""}>حذف نهائي</button>` : ""}</div>`}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    `;

    table.querySelectorAll(".owner-user-access-btn").forEach(button => {
      button.onclick = async () => {
        const userId = button.dataset.userId;
        const action = button.dataset.action;
        const email = button.dataset.email;
        const question = action === "suspend"
          ? `هل تريد إيقاف حساب ${email}؟ يمكن إعادة تفعيله لاحقًا.`
          : `هل تريد إعادة تفعيل حساب ${email}؟`;
        if (!confirm(question)) return;

        errorBox.style.display = "none";
        noticeBox.style.display = "none";
        button.disabled = true;
        button.textContent = action === "suspend" ? "جارٍ الإيقاف..." : "جارٍ التفعيل...";
        try {
          // Owner-only database function (checked again inside the database).
          const { error } = await supabase.rpc("owner_set_user_suspended", {
            p_user: userId,
            p_suspended: action === "suspend"
          });
          if (error) throw new Error(error.message || "تعذر تنفيذ العملية.");
          noticeBox.textContent = action === "suspend"
            ? `تم إيقاف حساب ${email}. لا يستطيع الدخول ولا رؤية أي ملف.`
            : `تمت إعادة تفعيل حساب ${email}.`;
          noticeBox.style.display = "block";
          await loadUsers();
        } catch (error) {
          errorBox.textContent = `تعذر تنفيذ العملية: ${error.message || "خطأ غير معروف"}. تأكد من تشغيل الملف migration_owner_suspend_v12.sql في Supabase (SQL Editor).`;
          errorBox.style.display = "block";
          button.disabled = false;
          button.textContent = action === "suspend" ? "إيقاف الحساب" : "إعادة التفعيل";
        }
      };
    });
    table.querySelectorAll(".owner-delete-student-btn").forEach(button => {
      button.onclick = async () => {
        const email = button.dataset.email;
        if (!confirm(`تحذير: سيتم حذف حساب الطالب ${email} نهائيًا من Auth. لا يمكن التراجع عن ذلك. هل تريد المتابعة؟`)) return;
        button.disabled = true; button.textContent = "جارٍ الحذف...";
        try {
          const { data, error } = await supabase.functions.invoke("delete-student-account", {
            body: { userId: button.dataset.userId }
          });
          if (error) throw new Error(error.message || "تعذر الاتصال بوظيفة الحذف.");
          if (data?.error) throw new Error(data.error);
          alert("تم حذف حساب الطالب بنجاح.");
          await loadUsers(); await loadDeletionRequests();
        } catch (err) {
          alert(`لم يتم حذف الحساب: ${err.message || "خطأ غير معروف"}. تأكد من نشر Edge Function باسم delete-student-account.`);
          button.disabled = false; button.textContent = "حذف نهائي";
        }
      };
    });
  }

  async function loadDeletionRequests() {
    const host = page.querySelector("#ownerDeletionRequests");
    if (!host) return;
    try {
      const { data, error } = await supabase.from("account_deletion_requests")
        .select("id,user_id,student_email,reason,status,created_at")
        .eq("status", "pending").order("created_at", { ascending: false });
      if (error) throw error;
      if (!data?.length) { host.innerHTML = `<p style="color:var(--muted);">لا توجد طلبات حذف معلقة.</p>`; return; }
      host.innerHTML = `<div style="display:grid;gap:10px;">${data.map(r => `<article style="border:1px solid var(--line);border-radius:12px;padding:13px;">
        <b class="mono" dir="ltr">${escapeHtml(r.student_email || r.user_id)}</b><p style="margin:8px 0;color:var(--muted);font-size:13px;">${escapeHtml(r.reason || "لم يذكر الطالب سببًا.")}</p>
        <small style="color:var(--muted);">${formatDate(r.created_at)}</small>
        <div style="margin-top:10px;"><button class="btn-danger owner-delete-request-btn" data-user-id="${escapeHtml(r.user_id)}" data-request-id="${r.id}">مراجعة وحذف حساب الطالب</button></div>
      </article>`).join("")}</div>`;
      host.querySelectorAll(".owner-delete-request-btn").forEach(btn => btn.onclick = async () => {
        if (!confirm("هل تأكدت من هوية الطالب؟ سيتم حذف حساب الطالب نهائيًا بعد التأكيد.")) return;
        btn.disabled = true; btn.textContent = "جارٍ تنفيذ الحذف...";
        try {
          const { data: result, error: invokeError } = await supabase.functions.invoke("delete-student-account", {
            body: { userId: btn.dataset.userId, requestId: Number(btn.dataset.requestId) }
          });
          if (invokeError) throw new Error(invokeError.message);
          if (result?.error) throw new Error(result.error);
          await loadDeletionRequests(); await loadUsers();
        } catch (err) { alert(`فشل الحذف: ${err.message || "خطأ غير معروف"}`); btn.disabled = false; btn.textContent = "مراجعة وحذف حساب الطالب"; }
      });
    } catch (err) {
      host.innerHTML = `<p style="color:var(--danger);">تعذر تحميل الطلبات: ${escapeHtml(err.message || "خطأ غير معروف")}. شغّل migration_account_messaging.sql أولًا.</p>`;
    }
  }

  async function loadStudentNameRequests() {
    const host = page.querySelector("#ownerStudentNameRequests");
    if (!host) return;
    try {
      const { data, error } = await supabase.from("student_name_requests")
        .select("id,user_id,student_email,requested_name,created_at")
        .eq("status","pending").order("created_at",{ascending:false});
      if (error) throw error;
      if (!data?.length) { host.innerHTML = `<p style="color:var(--muted);">لا توجد طلبات أسماء معلقة.</p>`; return; }
      host.innerHTML = `<div style="display:grid;gap:10px;">${data.map(r => `
        <article style="border:1px solid var(--line);border-radius:12px;padding:14px;">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <b>${escapeHtml(r.requested_name)}</b><small style="color:var(--muted);">${formatDate(r.created_at)}</small>
          </div>
          <div class="mono" dir="ltr" style="font-size:12px;color:var(--muted);margin-top:6px;">${escapeHtml(r.student_email || r.user_id)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
            <button type="button" class="btn-primary owner-name-request-review" data-id="${r.id}" data-approve="true">الموافقة على الاسم</button>
            <button type="button" class="btn-danger owner-name-request-review" data-id="${r.id}" data-approve="false">رفض الطلب</button>
          </div>
        </article>`).join("")}</div>`;
      host.querySelectorAll(".owner-name-request-review").forEach(btn => btn.onclick = async () => {
        const approved = btn.dataset.approve === "true";
        if (!confirm(approved ? "هل توافق على اعتماد هذا الاسم للطالب؟" : "هل تريد رفض طلب الاسم؟")) return;
        host.querySelectorAll("button").forEach(b => b.disabled = true);
        try {
          const { error: reviewError } = await supabase.rpc("owner_review_student_name_request", {
            p_request_id: Number(btn.dataset.id), p_approved: approved, p_note: null
          });
          if (reviewError) throw reviewError;
          await loadStudentNameRequests();
          alert(approved ? "تم اعتماد اسم الطالب." : "تم رفض طلب الاسم.");
        } catch (err) {
          alert("تعذرت مراجعة الطلب: " + (err.message || "خطأ غير معروف"));
          host.querySelectorAll("button").forEach(b => b.disabled = false);
        }
      });
    } catch (err) {
      host.innerHTML = `<p style="color:var(--danger);">تعذر تحميل طلبات الأسماء: ${escapeHtml(err.message || "خطأ غير معروف")}.</p>`;
    }
  }

  async function loadUsers() {
    table.innerHTML = `<p style="padding:18px;color:var(--muted);">جارٍ تحميل قائمة المستخدمين...</p>`;
    try {
      const { data, error } = await supabase.rpc("owner_list_users");
      if (error) throw new Error(error.message);
      users = Array.isArray(data) ? data : [];
      renderRows();
    } catch (error) {
      table.innerHTML = "";
      errorBox.textContent = `تعذر تحميل المستخدمين: ${error.message || "خطأ غير معروف"}. تأكد من تطبيق migration_security_v10.sql في مشروع Supabase الصحيح.`;
      errorBox.style.display = "block";
    }
  }

  groupFilter.onchange = renderRows;
  roleFilter.onchange = renderRows;
  searchInput.oninput = renderRows;
  await loadUsers();
  await loadDeletionRequests();
  await loadStudentNameRequests();
}


// Private owner/supervisor-to-student inbox. RLS enforces the group boundary in Supabase.
let activeGroupChatChannel = null;

async function renderStudentMessagesView(page) {
  // Close the previous page's listener before opening a new chat view.
  if (activeGroupChatChannel) {
    supabase.removeChannel(activeGroupChatChannel);
    activeGroupChatChannel = null;
  }
  const isStaff = ["owner", "admin", "uploader"].includes(state.role);
  const canChooseAnyGroup = ["owner", "admin"].includes(state.role);
  const availableGroups = canChooseAnyGroup ? [1,2,3,4,5,6,7,8,9,10] :
    [Number(isStaff ? state.uploaderGroup : state.studentGroup)].filter(g => Number.isInteger(g) && g >= 1 && g <= 10);

  page.innerHTML = '<div class="page-banner"><h2>الشات الجامعي</h2><p>تواصل في الشات العام أو شات فوجك، مع مساحة منفصلة للمراسلات الخاصة.</p></div>' +
    '<section class="content-card group-chat-shell"><div class="group-chat-heading"><div><h3>المحادثات الجماعية</h3><p class="learning-hint">اختر الشات العام أو افتح شات فوج محدد.</p></div><button type="button" class="btn-secondary" id="refreshGroupChat">تحديث</button></div>' +
    '<div class="group-chat-tabs" id="groupChatTabs"><button type="button" class="group-chat-tab active" data-chat-type="general">الشات العام</button>' +
    availableGroups.map(g => '<button type="button" class="group-chat-tab" data-chat-type="group" data-group="' + g + '">G' + g + '</button>').join("") +
    '</div><div class="group-chat-room-title" id="groupChatRoomTitle">الشات العام</div><div class="group-chat-messages" id="groupChatMessages"><p class="empty-state">جارٍ تحميل المحادثة...</p></div>' +
    '<form id="groupChatComposer" class="group-chat-composer"><textarea id="groupChatBody" class="form-control" rows="2" maxlength="3000" required placeholder="اكتب رسالة للجميع..."></textarea><button type="submit" class="btn-primary">إرسال</button></form><div id="groupChatFeedback" class="learning-hint"></div></section>' +
    '<details class="content-card private-inbox-panel" id="privateInboxPanel"><summary><span>المراسلات الخاصة</span><small>محادثات فردية بين الإدارة والطلاب</small></summary>' +
    (isStaff ? '<div class="private-compose"><h3>بدء مراسلة خاصة</h3><p class="learning-hint">يمكنك مراسلة طالب أو إرسال رسالة للفوج كاملًا؛ الرسائل الجماعية ستُجمع في مجموعة واحدة هنا.</p>' +
    '<form id="newStudentConversation" class="learning-form"><label class="form-label">الفوج</label><select id="messageGroup" class="form-control" required><option value="">اختر الفوج...</option></select>' +
    '<label class="form-label">الطالب</label><select id="messageStudent" class="form-control" required disabled><option value="">اختر الفوج أولًا</option></select>' +
    '<label class="form-label">موضوع الرسالة</label><input id="messageSubject" class="form-control" maxlength="160" required placeholder="موضوع مختصر">' +
    '<label class="form-label">نص الرسالة</label><textarea id="messageFirstBody" class="form-control" rows="3" maxlength="5000" required placeholder="اكتب رسالتك الخاصة..."></textarea><button class="btn-primary" type="submit">إرسال الرسالة الخاصة</button></form><div id="newMessageFeedback" class="learning-hint"></div></div>' : '') +
    '<div class="private-inbox-list"><h3>صندوق الرسائل الخاصة</h3><div id="studentConversationList">جارٍ تحميل المحادثات...</div></div><div id="studentConversationDetail" class="private-conversation-detail" style="display:none"></div></details>';

  const tabs = page.querySelector("#groupChatTabs");
  const chatMessages = page.querySelector("#groupChatMessages");
  const chatTitle = page.querySelector("#groupChatRoomTitle");
  const chatFeedback = page.querySelector("#groupChatFeedback");
  const composer = page.querySelector("#groupChatComposer");
  const chatInput = page.querySelector("#groupChatBody");
  const list = page.querySelector("#studentConversationList");
  const detail = page.querySelector("#studentConversationDetail");
  let activeChat = { type: "general", group: null };
  let conversations = [];
  let allowedStudents = [];

  let groupChatLoadVersion = 0;
  async function loadGroupChat() {
    const loadVersion = ++groupChatLoadVersion;
    chatTitle.textContent = activeChat.type === "general" ? "الشات العام · جميع الأفواج" : "شات الفوج G" + activeChat.group;
    chatMessages.innerHTML = '<p class="empty-state">جارٍ تحميل الرسائل...</p>';
    const result = await supabase.rpc("get_student_group_chat_messages", {
      p_chat_type: activeChat.type, p_group_no: activeChat.group
    });
    if (loadVersion !== groupChatLoadVersion) return;
    if (result.error) {
      chatMessages.innerHTML = '<p class="empty-state">تعذر تحميل الشات: ' + escapeHtml(result.error.message) + '<br>طبّق migration_group_chats.sql في Supabase أولًا.</p>';
      return;
    }
    if (loadVersion !== groupChatLoadVersion) return;
    const messages = result.data || [];
    if (!messages.length) {
      chatMessages.innerHTML = '<div class="group-chat-empty"><strong>بداية محادثة جديدة</strong><p>لا توجد رسائل بعد. كن أول من يشارك.</p></div>';
      return;
    }
    chatMessages.innerHTML = messages.map(m => {
      const mine = m.sender_id === state.user.id;
      const sender = mine ? (state.studentDisplayName || "أنت") : (m.sender_name || "عضو");
      const roleLabels = { owner: "المالك", admin: "الإدارة", uploader: "رئيس القسم", student: "طالب" };
      const senderRole = roleLabels[m.sender_role] || "";
      return '<article class="group-chat-message ' + (mine ? "mine" : "") + '"><div class="group-chat-message-meta"><strong>' +
        escapeHtml(sender) + '</strong>' + (senderRole ? '<span class="chat-sender-role">' + escapeHtml(senderRole) + '</span>' : '') +
        '<time>' + formatDate(m.created_at) + '</time></div><p>' + escapeHtml(m.body) + '</p></article>';
    }).join("");
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  tabs.querySelectorAll(".group-chat-tab").forEach(btn => btn.onclick = async () => {
    tabs.querySelectorAll(".group-chat-tab").forEach(x => x.classList.toggle("active", x === btn));
    activeChat = btn.dataset.chatType === "general" ? { type: "general", group: null } :
      { type: "group", group: Number(btn.dataset.group) };
    chatInput.placeholder = activeChat.type === "general" ? "اكتب رسالة للجميع..." : "اكتب رسالة لطلاب G" + activeChat.group + "...";
    chatFeedback.textContent = "";
    await loadGroupChat();
  });
  composer.onsubmit = async e => {
    e.preventDefault();
    const body = chatInput.value.trim();
    if (!body) return;
    const btn = composer.querySelector("button");
    btn.disabled = true;
    const result = await supabase.rpc("send_student_group_chat_message", {
      p_chat_type: activeChat.type, p_group_no: activeChat.group, p_body: body
    });
    btn.disabled = false;
    if (result.error) { chatFeedback.textContent = result.error.message; return; }
    chatInput.value = "";
    await loadGroupChat();
  };
  page.querySelector("#refreshGroupChat").onclick = loadGroupChat;

  if (isStaff) {
    const directory = await supabase.rpc("list_students_for_messaging");
    const groupSelect = page.querySelector("#messageGroup");
    const studentSelect = page.querySelector("#messageStudent");
    if (directory.error) {
      groupSelect.innerHTML = '<option value="">تعذر تحميل الطلاب: ' + escapeHtml(directory.error.message) + '</option>';
    } else {
      allowedStudents = directory.data || [];
      groupSelect.innerHTML = '<option value="">اختر الفوج...</option>' + availableGroups.map(g => {
        const count = allowedStudents.filter(x => Number(x.group_no) === g).length;
        return '<option value="' + g + '">G' + g + ' — ' + count + ' طالب</option>';
      }).join("");
      if (!canChooseAnyGroup && availableGroups.length === 1) {
        groupSelect.value = String(availableGroups[0]); groupSelect.disabled = true;
      }
    }
    groupSelect.onchange = () => {
      const g = Number(groupSelect.value);
      const inGroup = allowedStudents.filter(x => Number(x.group_no) === g);
      studentSelect.disabled = !groupSelect.value;
      studentSelect.innerHTML = !groupSelect.value ? '<option value="">اختر الفوج أولًا</option>' :
        '<option value="">اختر طالبًا...</option><option value="__all__">الفوج كاملًا — ' + inGroup.length + ' طالب</option>' +
        inGroup.map(x => '<option value="' + escapeHtml(x.user_id) + '">' + escapeHtml(x.display_name || "طالب بدون اسم") + '</option>').join("");
      if (groupSelect.value && !inGroup.length) studentSelect.innerHTML = '<option value="">لا يوجد طلاب في هذا الفوج</option>';
    };
    if (groupSelect.value) groupSelect.dispatchEvent(new Event("change"));
    page.querySelector("#newStudentConversation").onsubmit = async e => {
      e.preventDefault();
      const feedback = page.querySelector("#newMessageFeedback");
      const studentId = studentSelect.value, groupNo = Number(groupSelect.value);
      const subject = page.querySelector("#messageSubject").value.trim();
      const body = page.querySelector("#messageFirstBody").value.trim();
      try {
        if (!Number.isInteger(groupNo) || groupNo < 1 || groupNo > 10) throw new Error("اختر الفوج أولًا.");
        const broadcast = studentId === "__all__";
        if (!studentId) throw new Error("اختر طالبًا أو الفوج كاملًا.");
        if (!broadcast && !allowedStudents.some(x => x.user_id === studentId && Number(x.group_no) === groupNo)) throw new Error("الطالب لا ينتمي إلى الفوج المحدد.");
        if (!subject || !body) throw new Error("أدخل الموضوع ونص الرسالة.");
        const sent = await supabase.rpc("send_staff_student_message", {
          p_group_no: groupNo, p_student_id: broadcast ? null : studentId, p_subject: subject, p_body: body
        });
        if (sent.error) throw sent.error;
        page.querySelector("#messageFirstBody").value = "";
        page.querySelector("#messageSubject").value = "";
        feedback.textContent = broadcast ? "أُرسلت الرسالة إلى الفوج، وستظهر كمجموعة واحدة داخل صندوق المراسلات الخاصة." : "تم إرسال الرسالة الخاصة.";
        await loadConversations();
        page.querySelector("#privateInboxPanel").open = true;
      } catch (err) { feedback.textContent = err.message || "تعذر إرسال الرسالة."; }
    };
  }

  async function loadConversations() {
    const result = await supabase.from("student_conversations")
      .select("id,student_id,group_no,subject,created_at,updated_at,created_by")
      .order("updated_at", { ascending: false });
    if (result.error) { list.innerHTML = '<p class="empty-state">تعذر تحميل الرسائل الخاصة: ' + escapeHtml(result.error.message) + '</p>'; return; }
    conversations = result.data || [];
    if (!conversations.length) { list.innerHTML = '<p class="empty-state">لا توجد مراسلات خاصة حتى الآن.</p>'; return; }

    // Group the per-student threads created by a single broadcast into one expandable row.
    const grouped = new Map();
    conversations.forEach(c => {
      const key = [c.group_no, c.subject, c.created_by || "", c.created_at].join("|");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(c);
    });
    list.innerHTML = [...grouped.values()].map(items => {
      if (items.length > 1) {
        const inner = items.map(c => {
          const student = allowedStudents.find(x => x.user_id === c.student_id);
          const name = student ? student.display_name : (c.student_id === state.user.id ? "حسابي" : "طالب");
          return '<button type="button" class="btn-secondary conversation-open-btn" data-id="' + c.id + '">' +
            escapeHtml(name || "طالب") + '<small>' + formatDate(c.updated_at) + '</small></button>';
        }).join("");
        return '<details class="private-broadcast-group"><summary><strong>رسالة جماعية إلى G' + items[0].group_no +
          '</strong><small>' + items.length + ' محادثة خاصة</small></summary><div class="private-broadcast-children">' + inner + '</div></details>';
      }
      const c = items[0];
      const student = allowedStudents.find(x => x.user_id === c.student_id);
      const name = isStaff ? (student?.display_name || "محادثة مع طالب") : "محادثة مع الإدارة";
      return '<button type="button" class="btn-secondary conversation-open-btn private-thread-btn" data-id="' + c.id + '">' +
        '<strong>' + escapeHtml(name) + '</strong><small>G' + c.group_no + ' · ' + escapeHtml(c.subject) + ' · ' + formatDate(c.updated_at) + '</small></button>';
    }).join("");
    list.querySelectorAll(".conversation-open-btn").forEach(btn => btn.onclick = () => openConversation(btn.dataset.id));
  }

  async function openConversation(id) {
    const c = conversations.find(x => String(x.id) === String(id));
    if (!c) return;
    const result = await supabase.from("student_messages").select("id,sender_id,body,created_at")
      .eq("conversation_id", id).order("created_at");
    if (result.error) { detail.style.display = "block"; detail.textContent = result.error.message; return; }
    const ids = [...new Set((result.data || []).map(m => m.sender_id))];
    const profiles = ids.length ? await supabase.from("student_profiles").select("user_id,display_name").in("user_id", ids) : { data: [] };
    const names = new Map((profiles.data || []).map(p => [p.user_id, p.display_name]));
    detail.style.display = "block";
    detail.innerHTML = '<h3>' + escapeHtml(c.subject) + '</h3><p class="learning-hint">محادثة خاصة · الفوج G' + c.group_no + '</p><div class="private-message-thread">' +
      (result.data || []).map(m => {
        const mine = m.sender_id === state.user.id;
        const name = names.get(m.sender_id) || (mine ? state.studentDisplayName || "أنت" : (isStaff ? "الطالب" : "الإدارة"));
        return '<article class="private-message-bubble ' + (mine ? "mine" : "") + '"><strong>' + escapeHtml(name) +
          '</strong><p>' + escapeHtml(m.body) + '</p><time>' + formatDate(m.created_at) + '</time></article>';
      }).join("") + '</div><form id="replyStudentMessage" class="private-reply-form"><textarea id="replyStudentBody" class="form-control" rows="2" maxlength="5000" required placeholder="اكتب ردك الخاص..."></textarea><button class="btn-primary" type="submit">إرسال الرد</button></form><div id="replyStudentFeedback" class="learning-hint"></div>';
    detail.querySelector("#replyStudentMessage").onsubmit = async e => {
      e.preventDefault();
      const btn = e.submitter, body = detail.querySelector("#replyStudentBody").value.trim();
      if (!body) return;
      btn.disabled = true;
      try {
        const sent = await supabase.from("student_messages").insert({ conversation_id: c.id, sender_id: state.user.id, body });
        if (sent.error) throw sent.error;
        await loadConversations(); await openConversation(c.id);
      } catch (err) { detail.querySelector("#replyStudentFeedback").textContent = err.message || "تعذر إرسال الرد."; }
      finally { btn.disabled = false; }
    };
  }

  // Listen for new rows. Postgres RLS ensures each member receives only
  // events for rooms they are already allowed to read.
  activeGroupChatChannel = supabase
    .channel("student-group-chat-" + state.user.id + "-" + Date.now())
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "student_group_chat_messages"
    }, payload => {
      const message = payload.new || {};
      const belongsToOpenRoom = message.chat_type === activeChat.type &&
        (activeChat.type === "general" ? message.group_no == null : Number(message.group_no) === Number(activeChat.group));
      if (belongsToOpenRoom) loadGroupChat();
    })
    .subscribe(status => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        chatFeedback.textContent = "تعذر الاتصال بالتحديث الفوري. تحقق من اتصال الإنترنت وإعداد Realtime.";
      } else if (status === "SUBSCRIBED") {
        chatFeedback.textContent = "التحديث الفوري للرسائل مفعّل.";
      }
    });

  await loadGroupChat();
  await loadConversations();
}
// 19. PAGE: MINIMAL ADMIN FOR OWNER ONLY (#/admin)
async function renderAdminView(page) {
  page.innerHTML = `
    <div class="page-banner">
      <h2>الإدارة</h2>
      <p>${state.role === "owner" ? "إدارة المستخدمين والصلاحيات لجميع الأفواج. المالك وحده يدير المشرفين العامين." : "مراجعة طلبات تغيير الفوج، وإضافة رؤساء الأقسام وإدارتهم. لا يمكن للمشرف إضافة مشرف عام."}</p>
    </div>

    <!-- Student group-change requests: visible only to owner/admin through the protected admin route -->
    <div class="content-card">
      <h3 style="font-size:16px;font-weight:700;color:var(--brown-dark);margin-bottom:6px;">طلبات تعيين / تغيير الأفواج</h3>
      <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">راجع طلبات الطلاب. الموافقة تغيّر الفوج المعتمد في قاعدة البيانات؛ الرفض لا يغيّر فوج الطالب.</p>
      <div id="groupRequestsAdminTable"><p style="padding:16px;color:var(--muted);">جاري تحميل الطلبات...</p></div>
    </div>

    ${state.role === "owner" ? `
    <!-- Card 0: Admins (owner only) -->
    <div class="content-card">
      <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 6px;">المشرفون</h3>
      <p style="font-size: 12px; color: var(--muted); margin-bottom: 12px;">إضافة المشرفين العامين وإلغاءهم صلاحية حصرية للمالك. أما المشرف فيستطيع تعيين رؤساء الأقسام وإدارتهم دون ترقية أي مستخدم إلى مشرف عام.</p>
      <div id="addAdminAlertError" class="auth-error-box"></div>
      <div id="addAdminAlertSuccess" class="auth-success-box"></div>
      <form id="addAdminForm" style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 16px;">
        <div class="form-group" style="flex: 2; min-width: 220px; margin-bottom: 0;">
          <label class="form-label" for="adminEmailInput">البريد الإلكتروني *</label>
          <input type="email" id="adminEmailInput" class="form-control mono" placeholder="admin@example.com" required>
        </div>
        <button type="submit" class="btn-primary" id="addAdminSubmitBtn" style="width: auto; min-width: 110px; height: 42px;">إضافة مشرف</button>
      </form>
      <div id="adminsListTableWrapper">
        <div style="padding: 20px; text-align: center; color: var(--muted);">جاري تحميل القائمة...</div>
      </div>
    </div>
    ` : ""}

    <!-- Card 1: Add Section Head (owner only) -->
    <div class="content-card" style="${state.role === "owner" ? "" : "display:none;"}">
      <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 12px;">إضافة رئيس قسم</h3>
      <div id="addHeadAlertError" class="auth-error-box"></div>
      <div id="addHeadAlertSuccess" class="auth-success-box"></div>

      <form id="addHeadForm" style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
        <div class="form-group" style="flex: 2; min-width: 220px; margin-bottom: 0;">
          <label class="form-label" for="headEmailInput">البريد الإلكتروني للطالب *</label>
          <input type="email" id="headEmailInput" class="form-control mono" placeholder="student@univ.dz" required>
        </div>

        <div class="form-group" style="flex: 1; min-width: 140px; margin-bottom: 0;">
          <label class="form-label" for="headGroupSelect">الفوج *</label>
          <select id="headGroupSelect" class="form-control mono" required>
            ${[1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}">G${g}</option>`).join("")}
          </select>
        </div>

        <button type="submit" class="btn-primary" id="addHeadSubmitBtn" style="width: auto; min-width: 110px; height: 42px;">
          إضافة
        </button>
      </form>
    </div>

    <!-- Card 2: Section Heads Table (owner only) -->
    <div class="content-card" style="${state.role === "owner" ? "" : "display:none;"}">
      <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 8px;">رؤساء الأقسام</h3>
      <p style="font-size: 12px; color: var(--muted); margin-bottom: 14px;">إدارة وتعيين رؤساء الأقسام من اختصاص مالك المنصة فقط.</p>
      
      <div id="headsListTableWrapper">
        <div style="padding: 20px; text-align: center; color: var(--muted);">جاري تحميل القائمة...</div>
      </div>
    </div>
  `;

  const adminRequestsWrapper = document.getElementById("groupRequestsAdminTable");
  async function loadGroupChangeRequestsForAdmin() {
    if (!adminRequestsWrapper) return;
    try {
      const { data, error } = await supabase.from("group_change_requests")
        .select("id,user_id,current_group,requested_group,reason,status,created_at,student_email,admin_note")
        .eq("status", "pending").order("created_at", { ascending: true }).limit(100);
      if (error) throw error;
      if (!data || data.length === 0) {
        adminRequestsWrapper.innerHTML = `<p style="padding:16px;color:var(--muted);">لا توجد طلبات جديدة قيد المراجعة.</p>`;
        return;
      }
      adminRequestsWrapper.innerHTML = `<div class="table-responsive"><table class="data-table"><thead><tr><th>بريد الطالب</th><th>الفوج الحالي</th><th>الفوج المطلوب</th><th>السبب</th><th>الAction</th></tr></thead><tbody>${data.map(r => `<tr><td class="mono">${escapeHtml(r.student_email || "—")}</td><td class="mono">${r.current_group ? `G${r.current_group}` : "غير محدد"}</td><td class="mono">G${r.requested_group}</td><td style="min-width:180px;white-space:normal;">${escapeHtml(r.reason)}</td><td><div style="display:flex;gap:6px;flex-wrap:wrap;"><button type="button" class="btn-primary group-request-approve" data-id="${r.id}" data-group="${r.requested_group}" style="width:auto;padding:6px 10px;">موافقة</button><button type="button" class="btn-danger group-request-reject" data-id="${r.id}" style="width:auto;padding:6px 10px;">رفض</button></div></td></tr>`).join("")}</tbody></table></div>`;
      adminRequestsWrapper.querySelectorAll(".group-request-approve").forEach(btn => {
        btn.onclick = async () => {
          const id = Number(btn.dataset.id);
          const group = Number(btn.dataset.group);
          const note = prompt(`أضف ملاحظة للطالب (اختياري). سيتم تعيينه إلى G${group}:`, "");
          if (note === null) return;
          btn.disabled = true;
          const { error: reviewError } = await supabase.rpc("review_group_change_request", { p_request_id: id, p_approve: true, p_admin_note: note.trim() || null });
          if (reviewError) { alert(`تعذرت الموافقة: ${reviewError.message}`); btn.disabled = false; return; }
          alert(`تمت الموافقة وتعيين الفوج G${group}.`);
          await loadGroupChangeRequestsForAdmin();
        };
      });
      adminRequestsWrapper.querySelectorAll(".group-request-reject").forEach(btn => {
        btn.onclick = async () => {
          const id = Number(btn.dataset.id);
          const note = prompt("اكتب سبب الرفض أو ملاحظة للطالب:", "");
          if (note === null) return;
          btn.disabled = true;
          const { error: reviewError } = await supabase.rpc("review_group_change_request", { p_request_id: id, p_approve: false, p_admin_note: note.trim() || null });
          if (reviewError) { alert(`تعذر رفض الطلب: ${reviewError.message}`); btn.disabled = false; return; }
          await loadGroupChangeRequestsForAdmin();
        };
      });
    } catch (err) {
      console.warn("Could not load admin group requests:", err);
      adminRequestsWrapper.innerHTML = `<div class="auth-error-box" style="display:block;">تعذر تحميل الطلبات. تأكد من تطبيق ملف migration_group_change_requests.sql في Supabase. التفاصيل: ${escapeHtml(err.message || "Unknown error")}</div>`;
    }
  }
  loadGroupChangeRequestsForAdmin();

  const addForm = document.getElementById("addHeadForm");
  const alertErr = document.getElementById("addHeadAlertError");
  const alertSucc = document.getElementById("addHeadAlertSuccess");
  const addBtn = document.getElementById("addHeadSubmitBtn");
  const emailInput = document.getElementById("headEmailInput");
  const groupSelect = document.getElementById("headGroupSelect");

  addForm.onsubmit = async (e) => {
    e.preventDefault();
    if (state.role !== "owner") {
      alertErr.textContent = "تعيين رؤساء الأقسام متاح لمالك المنصة فقط.";
      alertErr.style.display = "block";
      return;
    }
    alertErr.style.display = "none";
    alertSucc.style.display = "none";

    const targetEmail = emailInput.value.trim().toLowerCase();
    const targetGroup = parseInt(groupSelect.value, 10);

    if (!targetEmail) return;

    addBtn.disabled = true;
    addBtn.textContent = "جاري الفحص...";

    try {
      // 1. Find the registered account using the restricted owner/admin head-management RPC.
      const { data: users, error: listErr } = await supabase.rpc("admin_list_users_for_heads");
      if (listErr) throw new Error(listErr.message);

      // 2. Find user by case-insensitive email
      const matchedUser = (users || []).find(u => (u.email || "").toLowerCase() === targetEmail);

      if (!matchedUser) {
        alertErr.textContent = "هذا الإيميل ما سجلش حساب بعد، خلي رئيس القسم يسجل أول.";
        alertErr.style.display = "block";
        addBtn.disabled = false;
        addBtn.textContent = "إضافة";
        return;
      }

      if (listedUserRole(matchedUser) === "owner") {
        alertErr.textContent = "لا يمكن تعيين المالك كرئيس قسم.";
        alertErr.style.display = "block";
        addBtn.disabled = false;
        addBtn.textContent = "إضافة";
        return;
      }
      if (state.role === "admin" && listedUserRole(matchedUser) === "admin") {
        alertErr.textContent = "لا يستطيع المشرف العام تغيير رتبة مشرف عام آخر.";
        alertErr.style.display = "block";
        addBtn.disabled = false;
        addBtn.textContent = "إضافة";
        return;
      }

      addBtn.textContent = "جاري التعيين...";

      // 3. Call owner_set_uploader
      const { error: setErr } = await supabase.rpc("owner_set_uploader", {
        p_user: listedUserId(matchedUser),
        p_group: targetGroup
      });

      if (setErr) throw new Error(setErr.message);

      alertSucc.textContent = `تم تعيين ${matchedUser.email} رئيساً للفوج G${targetGroup} بنجاح.`;
      alertSucc.style.display = "block";
      emailInput.value = "";
      loadRealHeadsTable();
    } catch (err) {
      alertErr.textContent = `خطأ: ${err.message}`;
      alertErr.style.display = "block";
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = "إضافة";
    }
  };

  async function loadRealHeadsTable() {
    if (state.role !== "owner") return;
    const wrapper = document.getElementById("headsListTableWrapper");
    if (!wrapper) return;

    try {
      const { data: users, error } = await supabase.rpc("admin_list_users_for_heads");
      if (error) {
        wrapper.innerHTML = `<div class="auth-error-box" style="display:block;">خطأ: ${escapeHtml(error.message)}</div>`;
        return;
      }

      // Filter users whose user_role = "uploader"
      const uploaderHeads = (users || []).filter(u => listedUserRole(u) === "uploader");

      if (uploaderHeads.length === 0) {
        wrapper.innerHTML = `<div style="text-align: center; padding: 24px; color: var(--muted); font-size: 14px;">ما عينتش حتى رئيس قسم بعد</div>`;
        return;
      }

      wrapper.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>البريد الإلكتروني</th>
                <th>الفوج</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${uploaderHeads.map(h => `
                <tr>
                  <td class="mono">${escapeHtml(h.email)}</td>
                  <td class="mono">G${listedUserGroup(h) || "—"}</td>
                  <td>
                    <button type="button" class="btn-danger remove-head-row-btn" data-uid="${listedUserId(h)}" data-email="${escapeHtml(h.email)}">
                      إلغاء
                    </button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;

      wrapper.querySelectorAll(".remove-head-row-btn").forEach(rBtn => {
        rBtn.onclick = async () => {
          const uid = rBtn.getAttribute("data-uid");
          const uemail = rBtn.getAttribute("data-email");
          if (!confirm(`هل أنت متأكد من إلغاء تعيين رئيس القسم (${uemail})؟`)) return;

          rBtn.disabled = true;
          rBtn.textContent = "جاري الإلغاء...";

          const { error: remErr } = await supabase.rpc("owner_remove_uploader", { p_user: uid });
          if (remErr) {
            alert(`فشل الإلغاء: ${remErr.message}`);
            rBtn.disabled = false;
            rBtn.textContent = "إلغاء";
          } else {
            loadRealHeadsTable();
          }
        };
      });

    } catch (err) {
      wrapper.innerHTML = `<div class="auth-error-box" style="display:block;">خطأ: ${escapeHtml(err.message)}</div>`;
    }
  }

  loadRealHeadsTable();

  // ---- Admins management (owner only; the database enforces this too) ----
  if (state.role === "owner") {
    const adminForm = document.getElementById("addAdminForm");
    const adminErr = document.getElementById("addAdminAlertError");
    const adminSucc = document.getElementById("addAdminAlertSuccess");
    const adminBtn = document.getElementById("addAdminSubmitBtn");
    const adminEmail = document.getElementById("adminEmailInput");

    async function loadAdminsTable() {
      const wrapper = document.getElementById("adminsListTableWrapper");
      if (!wrapper) return;
      const { data: users, error } = await supabase.rpc("owner_list_users");
      if (error) {
        wrapper.innerHTML = `<div class="auth-error-box" style="display:block;">خطأ: ${escapeHtml(error.message)}</div>`;
        return;
      }
      const admins = (users || []).filter(u => listedUserRole(u) === "admin");
      if (admins.length === 0) {
        wrapper.innerHTML = `<div style="text-align: center; padding: 18px; color: var(--muted); font-size: 14px;">لا يوجد مشرفون بعد</div>`;
        return;
      }
      wrapper.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead><tr><th>البريد الإلكتروني</th><th>Action</th></tr></thead>
            <tbody>
              ${admins.map(a => `
                <tr>
                  <td class="mono">${escapeHtml(a.email)}</td>
                  <td><button type="button" class="btn-danger remove-admin-btn" data-uid="${listedUserId(a)}" data-email="${escapeHtml(a.email)}">إلغاء</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;
      wrapper.querySelectorAll(".remove-admin-btn").forEach(btn => {
        btn.onclick = async () => {
          if (!confirm(`هل أنت متأكد من إلغاء المشرف (${btn.getAttribute("data-email")})؟`)) return;
          btn.disabled = true;
          const { error: remErr } = await supabase.rpc("owner_remove_admin", { p_user: btn.getAttribute("data-uid") });
          if (remErr) {
            alert(`فشل الإلغاء: ${remErr.message}`);
            btn.disabled = false;
            return;
          }
          loadAdminsTable();
        };
      });
    }

    adminForm.onsubmit = async (e) => {
      e.preventDefault();
      adminErr.style.display = "none";
      adminSucc.style.display = "none";
      const targetEmail = adminEmail.value.trim().toLowerCase();
      if (!targetEmail) return;

      adminBtn.disabled = true;
      adminBtn.textContent = "جاري الفحص...";
      try {
        const { data: users, error: listErr } = await supabase.rpc("owner_list_users");
        if (listErr) throw new Error(listErr.message);
        const matched = (users || []).find(u => (u.email || "").toLowerCase() === targetEmail);
        if (!matched) {
          adminErr.textContent = "هذا الإيميل ما سجلش حساب بعد، خليه يسجل أول.";
          adminErr.style.display = "block";
          return;
        }
        if (listedUserRole(matched) === "owner") {
          adminErr.textContent = "هذا الحساب هو المالك بالفعل.";
          adminErr.style.display = "block";
          return;
        }
        const { error: setErr } = await supabase.rpc("owner_set_admin", { p_user: listedUserId(matched) });
        if (setErr) throw new Error(setErr.message);

        adminSucc.textContent = `تم تعيين ${matched.email} مشرفا بنجاح. التغيير يتطبق عند تسجيل دخوله القادم.`;
        adminSucc.style.display = "block";
        adminEmail.value = "";
        loadAdminsTable();
        loadRealHeadsTable();
      } catch (err) {
        adminErr.textContent = `خطأ: ${err.message}`;
        adminErr.style.display = "block";
      } finally {
        adminBtn.disabled = false;
        adminBtn.textContent = "إضافة مشرف";
      }
    };

    loadAdminsTable();
  }
}

// 20. PAGE: UPLOAD FILE (#/upload) FOR OWNER & HEAD
async function renderUploadView(page) {
  const isOwner = state.role === "owner";
  const isAdmin = state.role === "admin";
  const isStaff = isOwner || isAdmin;
  const upGroup = state.uploaderGroup;

  page.innerHTML = `
    <div class="page-banner">
      <h2>رفع الملفات</h2>
      <p>رفع ومشاركة ملفات المواد الأكاديمية (PDF فقط).</p>
    </div>

    <!-- Upload Form -->
    <div class="content-card">
      <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 16px;">رفع ملف جديد</h3>
      <div id="uploadAlertBox" class="auth-error-box"></div>
      <div id="uploadSuccessBox" class="auth-success-box"></div>

      <form id="fileUploadForm">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;">
          <div class="form-group">
            <label class="form-label" for="uploadTitle">عنوان الملف *</label>
            <input type="text" id="uploadTitle" class="form-control" placeholder="مثال: Série 01 - Les Pointeurs" required>
          </div>

          <div class="form-group">
            <label class="form-label" for="uploadSubject">المقياس *</label>
            <select id="uploadSubject" class="form-control" required>
              ${SUBJECT_DEFINITIONS.map(s => `<option value="${s.id}">${escapeHtml((s.nameEn || s.nameFr || s.nameAr))} (${s.id})</option>`).join("")}
              <option value="Autre">Autre (أخرى)</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="uploadKind">نوع الحصة *</label>
            <select id="uploadKind" class="form-control mono" required>
              ${isStaff ? '<option value="cours">cours (محاضرة)</option>' : ''}
              <option value="td">td (أعمال موجهة)</option>
              <option value="tp">tp (أعمال تطبيقية)</option>
              <option value="exam">exam (امتحان)</option>
              <option value="autre">autre (أخرى)</option>
            </select>
          </div>

          <div class="form-group" id="uploadGroupWrap">
            <label class="form-label" for="uploadGroup">الفوج المستهدف *</label>
            <select id="uploadGroup" class="form-control mono" ${!isStaff ? 'disabled' : 'required'}>
              ${
                isStaff
                  ? `
                    <option value="">— اختر الفوج —</option>
                    <option value="all">كل الأفواج (ملف مشترك)</option>
                    ${[1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}">G${g}</option>`).join("")}
                  `
                  : `<option value="${upGroup}" selected>G${upGroup} (فوجك فقط)</option>`
              }
            </select>
          </div>
        </div>

        ${isStaff ? `
          <div class="content-card" style="margin-top:14px;padding:14px 16px;background:var(--cream, #fbf7f0);border:1px solid var(--line);">
            <label for="uploadAllGroups" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-weight:700;color:var(--brown-dark);">
              <input type="checkbox" id="uploadAllGroups" style="width:18px;height:18px;margin-top:2px;accent-color:var(--brown);">
              <span>ملف PDF شامل واحد لجميع الأفواج</span>
            </label>
            <p style="margin:7px 0 0 28px;color:var(--muted);font-size:12px;line-height:1.7;">فعّل هذا الخيار إذا كان الملف يحتوي على البرنامج الكامل أو محتوى مشترك. ارفع الملف مرة واحدة فقط، وسيظهر للطلاب في G1 إلى G10 دون الحاجة إلى تكرار رفعه لكل فوج.</p>
          </div>
        ` : ''}

        <div class="form-group" style="margin-top: 14px;">
          <label class="form-label" for="uploadFileInput">اختر ملف PDF (الحد الأقصى 25 ميغابايت) *</label>
          <input type="file" id="uploadFileInput" class="form-control" accept=".pdf,application/pdf" required>
        </div>

        <button type="submit" class="btn-primary" id="uploadSubmitBtn" style="margin-top: 14px; width: auto; min-width: 160px;">
          رفع الملف
        </button>
      </form>
    </div>

    <!-- Files Management Table -->
    <div class="content-card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark);">
          ${isStaff ? "إدارة جميع ملفات المنصة" : `ملفاتي (الفوج G${upGroup})`}
        </h3>

        ${
          isStaff
            ? `
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <select id="filterUploadGroup" class="form-control mono" style="width: auto; padding: 4px 10px; font-size: 12px;">
                  <option value="all">كل الأفواج</option>
                  ${[1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}">G${g}</option>`).join("")}
                </select>
                <select id="filterUploadKind" class="form-control mono" style="width: auto; padding: 4px 10px; font-size: 12px;">
                  <option value="all">كل الأنواع</option>
                  <option value="cours">cours</option>
                  <option value="td">td</option>
                  <option value="tp">tp</option>
                  <option value="exam">exam</option>
                  <option value="autre">autre</option>
                </select>
              </div>
            `
            : ""
        }
      </div>

      <div id="uploadFilesTableWrapper">
        <!-- Render files -->
      </div>
    </div>
  `;

  const kindSelect = document.getElementById("uploadKind");
  const groupSelectWrap = document.getElementById("uploadGroupWrap");
  const groupSelect = document.getElementById("uploadGroup");
  const uploadForm = document.getElementById("fileUploadForm");
  const uploadBtn = document.getElementById("uploadSubmitBtn");
  const uploadAlert = document.getElementById("uploadAlertBox");
  const uploadSuccess = document.getElementById("uploadSuccessBox");
  const allGroupsCheckbox = document.getElementById("uploadAllGroups");
  const handleKindChange = () => {
    if (!isStaff || !groupSelectWrap) return;
    if (allGroupsCheckbox?.checked) {
      // One shared PDF for every group: no specific group is needed.
      groupSelectWrap.style.display = "none";
      if (groupSelect) groupSelect.required = false;
      uploadBtn.textContent = "رفع الملف الشامل لجميع الأفواج";
    } else {
      // Otherwise the group must be chosen explicitly, whatever the file type is.
      groupSelectWrap.style.display = "flex";
      if (groupSelect) groupSelect.required = true;
      uploadBtn.textContent = "رفع الملف";
    }
  };
  if (isStaff && kindSelect && groupSelectWrap) {
    kindSelect.onchange = handleKindChange;
    if (allGroupsCheckbox) allGroupsCheckbox.onchange = handleKindChange;
    handleKindChange();
  }

  uploadForm.onsubmit = async (e) => {
    e.preventDefault();
    uploadAlert.style.display = "none";
    uploadSuccess.style.display = "none";

    const title = document.getElementById("uploadTitle").value.trim();
    const subject = document.getElementById("uploadSubject").value;
    const kind = document.getElementById("uploadKind").value;
    const fileInput = document.getElementById("uploadFileInput");
    const file = fileInput.files[0];

    if (!file) {
      uploadAlert.textContent = "يرجى اختيار ملف PDF.";
      uploadAlert.style.display = "block";
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      uploadAlert.textContent = "يسمح فقط بملفات بصيغة PDF.";
      uploadAlert.style.display = "block";
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      uploadAlert.textContent = "حجم الملف يتجاوز 25 ميغابايت.";
      uploadAlert.style.display = "block";
      return;
    }

    // A single comprehensive PDF can be shared across all ten groups.
    // Null group_no is intentionally used for shared files and the storage path
    // is placed under common/, matching the existing access policies.
    // The file goes to the group chosen in the form (for every type, including "cours").
    // It is shared with all groups ONLY when "all groups" is chosen or the shared-PDF box is ticked.
    let targetGroup = null;
    if (isStaff) {
      if (allGroupsCheckbox?.checked) {
        targetGroup = null;
      } else {
        const val = groupSelect.value;
        if (!val) {
          uploadAlert.textContent = "اختر الفوج المستهدف، أو اختر \"كل الأفواج\" إذا كان الملف مشتركا.";
          uploadAlert.style.display = "block";
          return;
        }
        targetGroup = val === "all" ? null : parseInt(val, 10);
      }
    } else {
      targetGroup = upGroup;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = "جاري رفع الملف...";

    const timestamp = Date.now();
    const randStr = Math.random().toString(36).substring(2, 8);
    const folder = targetGroup ? `g${targetGroup}` : "common";
    const storagePath = `${folder}/${timestamp}_${randStr}.pdf`;

    let uploadedKey = null;

    try {
      const { error: storageError } = await supabase.storage
        .from("course-files")
        .upload(storagePath, file, {
          cacheControl: "3600",
          upsert: false
        });

      if (storageError) throw new Error(storageError.message);
      uploadedKey = storagePath;

      uploadBtn.textContent = "جاري حفظ بيانات الملف...";

      const { error: insertError } = await supabase.from("files").insert({
        title,
        semester: "S1",
        subject,
        kind,
        group_no: targetGroup,
        path: storagePath
      });

      if (insertError) {
        await supabase.storage.from("course-files").remove([uploadedKey]);
        throw new Error(insertError.message);
      }

      uploadSuccess.textContent = "تم رفع الملف وحفظه بنجاح.";
      uploadSuccess.style.display = "block";
      uploadForm.reset();
      handleKindChange();

      await loadFilesCache();
      renderUploadFilesTable();
    } catch (err) {
      uploadAlert.textContent = `خطأ: ${err.message || "فشلت عملية الرفع"}`;
      uploadAlert.style.display = "block";
    } finally {
      uploadBtn.disabled = false;
      handleKindChange();
    }
  };

  function renderUploadFilesTable() {
    const wrapper = document.getElementById("uploadFilesTableWrapper");
    if (!wrapper) return;

    let files = isStaff ? [...state.filesCache] : state.filesCache.filter(f => isFileForGroup(f, upGroup));

    if (isStaff) {
      const gFilter = document.getElementById("filterUploadGroup")?.value;
      const kFilter = document.getElementById("filterUploadKind")?.value;
      if (gFilter && gFilter !== "all") {
        files = files.filter(f => isFileForGroup(f, Number(gFilter)));
      }
      if (kFilter && kFilter !== "all") {
        files = files.filter(f => f.kind === kFilter);
      }
    }

    if (files.length === 0) {
      wrapper.innerHTML = `<div style="text-align: center; padding: 24px; color: var(--muted);">ما كاين حتى ملف بعد</div>`;
      return;
    }

    wrapper.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>العنوان</th>
              <th>المادة</th>
              <th>النوع</th>
              <th>الفوج</th>
              <th>التاريخ</th>
              <th>Actionات</th>
            </tr>
          </thead>
          <tbody>
            ${files.map(f => `
              <tr>
                <td><strong>${escapeHtml(f.title)}</strong></td>
                <td>${escapeHtml(getSubjectObj(normalizeSubjectId(f.subject)).nameEn || getSubjectObj(normalizeSubjectId(f.subject)).nameFr || f.subject)}</td>
                <td><span class="badge-tag">${escapeHtml(f.kind)}</span></td>
                <td class="mono">${getFileGroupNo(f) ? `G${getFileGroupNo(f)}` : "مشترك: كل الأفواج"}</td>
                <td class="mono" style="font-size: 12px;">${formatDate(f.created_at)}</td>
                <td>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
                    <a href="#/voir/${f.id}" class="btn-secondary" style="padding: 4px 8px; font-size: 12px; text-decoration: none;">عرض</a>
                    ${isStaff ? `
                      <select class="form-control mono move-group-select" data-id="${f.id}" style="width: auto; padding: 4px 8px; font-size: 12px;" title="نقل الملف إلى فوج آخر">
                        <option value="">نقل إلى...</option>
                        <option value="all">كل الأفواج</option>
                        ${[1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}">G${g}</option>`).join("")}
                      </select>` : ""}
                    <button type="button" class="btn-danger delete-file-btn" data-id="${f.id}" data-path="${escapeHtml(f.path)}" data-title="${escapeHtml(f.title)}">حذف</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    wrapper.querySelectorAll(".move-group-select").forEach(sel => {
      sel.onchange = async () => {
        const val = sel.value;
        if (!val) return;
        const file = state.filesCache.find(f => String(f.id) === String(sel.getAttribute("data-id")));
        if (!file) return;
        const target = val === "all" ? null : parseInt(val, 10);
        const label = target ? `G${target}` : "كل الأفواج";
        if (!confirm(`نقل الملف "${file.title}" إلى ${label}؟`)) {
          sel.value = "";
          return;
        }
        sel.disabled = true;
        try {
          await moveFileToGroup(file, target);
          await loadFilesCache();
          renderUploadFilesTable();
        } catch (err) {
          alert(`تعذر نقل الملف: ${err.message || err}`);
          sel.disabled = false;
          sel.value = "";
        }
      };
    });

    wrapper.querySelectorAll(".delete-file-btn").forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute("data-id");
        const path = btn.getAttribute("data-path");
        const title = btn.getAttribute("data-title");

        const ok = confirm(`هل أنت متأكد من حذف الملف "${title}" بشكل نهائي؟`);
        if (!ok) return;

        btn.disabled = true;
        btn.textContent = "جاري الحذف...";

        try {
          const { error: dbErr } = await supabase.from("files").delete().eq("id", id);
          if (dbErr) throw new Error(dbErr.message);

          if (path) {
            await supabase.storage.from("course-files").remove([path]);
          }

          await loadFilesCache();
          renderUploadFilesTable();
        } catch (err) {
          alert(`خطأ في الحذف: ${err.message}`);
          btn.disabled = false;
          btn.textContent = "حذف";
        }
      };
    });
  }

  if (isStaff) {
    document.getElementById("filterUploadGroup")?.addEventListener("change", renderUploadFilesTable);
    document.getElementById("filterUploadKind")?.addEventListener("change", renderUploadFilesTable);
  }

  renderUploadFilesTable();
}

// 21. PAGE: ACCOUNT (#/compte)
function renderAccountView(page) {
  const isOwner = state.role === "owner";
  const sg = state.studentGroup;
  const groupOptions = [1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}">G${g}</option>`).join("");
  page.innerHTML = `
    <div class="page-banner">
      <h2>حسابي</h2>
      <p>تفاصيل الحساب الدراسي والصلاحيات المسجلة.</p>
    </div>

    <div class="content-card" style="max-width:720px;">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">
        <div class="user-avatar-circle" style="width:56px;height:56px;font-size:22px;">
          ${escapeHtml(state.user.email?.[0]?.toUpperCase() || "U")}
        </div>
        <div>
          <h3 style="font-size:18px;font-weight:600;color:var(--brown-dark);">${escapeHtml(state.studentDisplayName || state.user.email)}</h3>
          <div class="mono" dir="ltr" style="font-size:12px;color:var(--muted);margin-top:4px;">${escapeHtml(state.user.email)}</div>
          <span class="role-badge ${state.role}" style="display:inline-block;margin-top:4px;">${getRoleBadgeText(state.role,state.uploaderGroup)}</span>
        </div>
      </div>

      ${state.role === "student" ? `
        <hr style="border:0;border-top:1px solid var(--line);margin:24px 0;">
        <section aria-labelledby="studentNameRequestTitle">
          <h3 id="studentNameRequestTitle" style="font-size:17px;font-weight:700;color:var(--brown-dark);margin-bottom:8px;">الاسم الظاهر في الموقع</h3>
          <p style="font-size:13px;color:var(--muted);line-height:1.8;margin-bottom:12px;">اكتب اسمك الحقيقي أو الاسم الذي تريد أن يظهر للطلاب. سيصل طلبك إلى مالك المنصة، ولن يتغير الاسم المعتمد إلا بعد موافقته.</p>
          <div id="studentNameRequestFeedback" role="status" style="font-size:13px;margin-bottom:8px;"></div>
          <form id="studentNameRequestForm" style="display:grid;gap:10px;">
            <label class="form-label" for="requestedStudentName">الاسم المقترح</label>
            <input id="requestedStudentName" class="form-control" type="text" minlength="2" maxlength="40" required value="${escapeHtml(state.studentDisplayName || "")}" placeholder="اكتب اسمك هنا">
            <button type="submit" class="btn-primary" id="sendStudentNameRequestBtn" style="width:auto;justify-self:start;padding:10px 18px;">إرسال الاسم للموافقة</button>
          </form>
          <div id="myStudentNameRequests" style="margin-top:16px;"><p style="font-size:13px;color:var(--muted);">جارٍ تحميل طلباتك...</p></div>
        </section>
      ` : ""}

      ${isOwner ? `
        <div style="border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--cream,#fbf7f0);">
          <h3 style="font-size:18px;font-weight:700;color:var(--brown-dark);margin-bottom:8px;">مالك منصة info cc 404</h3>
          <p style="color:var(--muted);line-height:1.9;margin:0;">هذا الحساب هو حساب مالك المنصة. يمكنك إدارة جميع الأفواج من 1 إلى 10، وإدارة المشرفين ورؤساء الأقسام والطلاب من لوحة المالك.</p>
          <a href="#/admin" class="btn-primary" style="display:inline-block;width:auto;text-decoration:none;padding:9px 16px;margin-top:12px;">فتح لوحة الإدارة</a>
        </div>
      ` : `
        <div class="form-group">
          <label class="form-label">فوجك الدراسي المسجل:</label>
          <div style="font-weight:600;font-size:16px;color:var(--brown-dark);" class="mono">${sg ? `الفوج G${sg}` : "غير محدد — يمكنك إرسال طلب إلى الإدارة لتعيين فوجك."}</div>
          <small style="color:var(--muted);font-size:12px;">لا يتغير الفوج إلا بعد موافقة الإدارة.</small>
        </div>

        <hr style="border:0;border-top:1px solid var(--line);margin:24px 0;">
        <section aria-labelledby="groupRequestTitle">
          <h3 id="groupRequestTitle" style="font-size:17px;font-weight:700;color:var(--brown-dark);margin-bottom:8px;">طلب تغيير / تعيين الفوج</h3>
          <p style="font-size:13px;color:var(--muted);margin-bottom:8px;">اختر الفوج الذي تدرس فيه فعلًا من القائمة ثم أرسل الطلب. لن يتغير فوجك مباشرة؛ المالك يراجع الطلب أو المشرف المفوض يراجعه.</p>
          <p style="font-size:12px;color:var(--muted);margin-bottom:16px;">بعد الموافقة، حدّث الصفحة أو سجّل الخروج ثم الدخول مجددًا حتى تظهر ملفات فوجك الصحيح.</p>
          <div id="groupRequestAlert" role="status" class="auth-success-box"></div>
          <div id="groupRequestError" role="alert" class="auth-error-box"></div>
          <form id="groupChangeRequestForm" style="display:grid;gap:12px;">
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label" for="requestedGroupSelect">الفوج المطلوب *</label>
              <select id="requestedGroupSelect" class="form-control mono" required>${groupOptions}</select>
            </div>
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label" for="groupRequestReason">سبب الطلب *</label>
              <textarea id="groupRequestReason" class="form-control" rows="3" maxlength="1000" required placeholder="مثال: فوجي غير ظاهر في حسابي، وأرغب في تعيين الفوج الصحيح."></textarea>
            </div>
            <button type="submit" class="btn-primary" id="sendGroupRequestBtn" style="width:auto;justify-self:start;padding:10px 18px;">إرسال الطلب إلى الإدارة</button>
          </form>
          <div style="margin-top:22px;">
            <h4 style="font-size:14px;font-weight:700;color:var(--brown-dark);margin-bottom:10px;">طلباتي السابقة</h4>
            <div id="myGroupRequests"><p style="color:var(--muted);font-size:13px;">جاري تحميل الطلبات...</p></div>
          </div>
        </section>
      `}

      ${state.role === "student" ? `
        <hr style="border:0;border-top:1px solid var(--line);margin:24px 0;">
        <section style="border:1px solid #e7c8bd;border-radius:13px;padding:16px;background:#fffaf8;">
          <h3 style="font-size:16px;color:#8b3c32;margin-bottom:6px;">طلب حذف حسابي</h3>
          <p style="font-size:13px;color:var(--muted);line-height:1.8;">يمكنك إرسال طلب إلى مالك المنصة. لن يُحذف الحساب تلقائيًا؛ المالك وحده يراجع الطلب وينفذ الحذف بعد التأكد.</p>
          <textarea id="accountDeletionReason" class="form-control" rows="2" maxlength="1000" placeholder="سبب الطلب (اختياري)" style="margin:10px 0;"></textarea>
          <div id="accountDeletionFeedback" role="status" style="font-size:13px;margin-bottom:8px;"></div>
          <button type="button" id="sendAccountDeletionRequest" class="btn-danger" style="padding:9px 15px;">إرسال طلب حذف الحساب</button>
        </section>
      ` : ""}
      <hr style="border:0;border-top:1px solid var(--line);margin:24px 0;">
      <button type="button" class="btn-danger" id="accountLogoutBtn" style="padding:10px 20px;font-size:14px;">تسجيل الخروج من الحساب</button>
    </div>
  `;

  const nameRequestForm = document.getElementById("studentNameRequestForm");
  if (nameRequestForm) {
    const nameFeedback = document.getElementById("studentNameRequestFeedback");
    const nameHistory = document.getElementById("myStudentNameRequests");
    async function loadMyStudentNameRequests() {
      try {
        const { data, error } = await supabase.from("student_name_requests")
          .select("id,requested_name,status,owner_note,created_at,reviewed_at")
          .order("created_at",{ascending:false}).limit(10);
        if (error) throw error;
        const labels = {pending:"قيد مراجعة المالك",approved:"تمت الموافقة",rejected:"مرفوض"};
        const colors = {pending:"#8a6d3b",approved:"#28734a",rejected:"#a33b32"};
        nameHistory.innerHTML = !data?.length ? `<p style="font-size:13px;color:var(--muted);">لم ترسل طلبات أسماء بعد.</p>` : data.map(r => `
          <div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-top:8px;">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <b>${escapeHtml(r.requested_name)}</b><strong style="font-size:12px;color:${colors[r.status] || "var(--muted)"};">${labels[r.status] || escapeHtml(r.status)}</strong>
            </div>
            <small style="color:var(--muted);">${formatDate(r.created_at)}</small>
            ${r.owner_note ? `<p style="font-size:12px;margin:6px 0 0;">رد المالك: ${escapeHtml(r.owner_note)}</p>` : ""}
          </div>`).join("");
      } catch (err) { nameHistory.innerHTML = `<p style="font-size:13px;color:var(--danger);">تعذر تحميل الطلبات: ${escapeHtml(err.message || "خطأ غير معروف")}</p>`; }
    }
    nameRequestForm.onsubmit = async event => {
      event.preventDefault();
      const input = document.getElementById("requestedStudentName");
      const name = input.value.trim().replace(/\s+/g," ");
      const btn = document.getElementById("sendStudentNameRequestBtn");
      nameFeedback.style.color = "var(--muted)";
      nameFeedback.textContent = "";
      if (name.length < 2 || name.length > 40) { nameFeedback.textContent = "الاسم يجب أن يكون بين حرفين و40 حرفًا."; return; }
      btn.disabled = true; btn.textContent = "جارٍ إرسال الطلب...";
      try {
        const { error } = await supabase.from("student_name_requests").insert({
          user_id: state.user.id, student_email: state.user.email || null, requested_name: name
        });
        if (error?.code === "23505") throw new Error("لديك طلب اسم قيد المراجعة بالفعل. انتظر قرار المالك.");
        if (error) throw error;
        nameFeedback.style.color = "var(--success,#28734a)";
        nameFeedback.textContent = "تم إرسال اسمك إلى المالك. سيظهر الاسم الجديد بعد الموافقة عليه.";
        await loadMyStudentNameRequests();
      } catch (err) {
        nameFeedback.style.color = "var(--danger,#a33b32)";
        nameFeedback.textContent = err.message || "تعذر إرسال الطلب.";
      } finally { btn.disabled = false; btn.textContent = "إرسال الاسم للموافقة"; }
    };
    loadMyStudentNameRequests();
  }

  const requestForm = document.getElementById("groupChangeRequestForm");
  if (requestForm) {
    const requestAlert = document.getElementById("groupRequestAlert");
    const requestError = document.getElementById("groupRequestError");
    const requestButton = document.getElementById("sendGroupRequestBtn");
    const requestsContainer = document.getElementById("myGroupRequests");

    async function loadMyGroupRequests() {
      try {
        const { data, error } = await supabase.from("group_change_requests")
          .select("id,current_group,requested_group,reason,status,admin_note,created_at,reviewed_at")
          .order("created_at", { ascending: false }).limit(20);
        if (error) throw error;
        if (!data || data.length === 0) {
          requestsContainer.innerHTML = `<p style="color:var(--muted);font-size:13px;">لا توجد طلبات سابقة.</p>`;
          return;
        }
        const statusLabels = { pending: "قيد المراجعة", approved: "تمت الموافقة", rejected: "مرفوض" };
        const statusColors = { pending: "#8a6d3b", approved: "#28734a", rejected: "#a33b32" };
        requestsContainer.innerHTML = `<div style="display:grid;gap:12px;">${data.map(r => `<article style="border:1px solid var(--line);border-radius:14px;padding:15px;background:var(--surface,#fff);box-shadow:0 2px 8px rgba(60,42,24,.04);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
            <strong style="color:var(--brown-dark);">طلب تغيير الفوج</strong>
            <span style="border-radius:20px;padding:5px 11px;background:${r.status === "approved" ? "#e8f4eb" : r.status === "rejected" ? "#faeae8" : "#f8f0df"};color:${statusColors[r.status] || "inherit"};font-size:12px;font-weight:700;">${statusLabels[r.status] || escapeHtml(r.status)}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px;">
            <div><small style="display:block;color:var(--muted);margin-bottom:4px;">الفوج المسجل وقت الطلب</small><b class="mono">${r.current_group ? `G${r.current_group}` : "غير محدد"}</b></div>
            <div><small style="display:block;color:var(--muted);margin-bottom:4px;">الفوج المطلوب</small><b class="mono">G${r.requested_group}</b></div>
            <div><small style="display:block;color:var(--muted);margin-bottom:4px;">تاريخ الإرسال</small><b style="font-size:13px;">${formatDate(r.created_at)}</b></div>
            <div><small style="display:block;color:var(--muted);margin-bottom:4px;">تاريخ المراجعة</small><b style="font-size:13px;">${r.reviewed_at ? formatDate(r.reviewed_at) : "لم تتم المراجعة بعد"}</b></div>
          </div>
          <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);"><small style="color:var(--muted);display:block;margin-bottom:4px;">سبب الطلب</small><p style="margin:0;line-height:1.7;">${escapeHtml(r.reason || "—")}</p></div>
          <div style="margin-top:9px;padding:10px 12px;border-radius:9px;background:var(--cream,#fbf7f0);"><small style="color:var(--muted);display:block;margin-bottom:4px;">رد الإدارة / نتيجة المراجعة</small><p style="margin:0;line-height:1.7;">${escapeHtml(r.admin_note || (r.status === "pending" ? "طلبك قيد المراجعة." : "لم تضف الإدارة ملاحظة."))}</p></div>
        </article>`).join("")}</div>`;
      } catch (err) {
        console.warn("Could not load group change requests:", err);
        requestsContainer.innerHTML = `<p style="color:var(--muted);font-size:13px;">تعذر تحميل الطلبات. تحقق من إعدادات طلبات تغيير الفوج. التفاصيل: ${escapeHtml(err.message || "خطأ غير معروف")}</p>`;
      }
    }

    requestForm.onsubmit = async event => {
      event.preventDefault();
      requestAlert.style.display = "none";
      requestError.style.display = "none";
      requestButton.disabled = true;
      requestButton.textContent = "جارٍ إرسال الطلب...";
      try {
        const requestedGroup = parseInt(document.getElementById("requestedGroupSelect").value, 10);
        const reason = document.getElementById("groupRequestReason").value.trim();
        if (!Number.isInteger(requestedGroup) || requestedGroup < 1 || requestedGroup > 10) throw new Error("اختر فوجًا صحيحًا من G1 إلى G10.");
        if (reason.length < 5) throw new Error("يرجى كتابة سبب واضح للطلب (5 أحرف على الأقل).");
        const { error } = await supabase.from("group_change_requests").insert({ requested_group: requestedGroup, reason });
        if (error) {
          if (error.code === "23505") throw new Error("لديك طلب قيد المراجعة بالفعل. انتظر رد الإدارة قبل إرسال طلب آخر.");
          if (error.code === "42P01" || error.code === "PGRST205") throw new Error("ميزة الطلبات تحتاج إلى تطبيق ملف migration_group_change_requests.sql في Supabase أولًا.");
          throw new Error(error.message);
        }
        requestAlert.textContent = "تم إرسال طلبك إلى الإدارة بنجاح. لن يتغير فوجك إلا بعد الموافقة.";
        requestAlert.style.display = "block";
        document.getElementById("groupRequestReason").value = "";
        await loadMyGroupRequests();
      } catch (err) {
        requestError.textContent = err.message || "تعذر إرسال الطلب. حاول لاحقًا.";
        requestError.style.display = "block";
      } finally {
        requestButton.disabled = false;
        requestButton.textContent = "إرسال الطلب إلى الإدارة";
      }
    };
    loadMyGroupRequests();
  }

  const deleteRequestButton = document.getElementById("sendAccountDeletionRequest");
  if (deleteRequestButton) deleteRequestButton.onclick = async () => {
    const feedback = document.getElementById("accountDeletionFeedback");
    deleteRequestButton.disabled = true;
    feedback.textContent = "جارٍ إرسال الطلب...";
    try {
      const reason = document.getElementById("accountDeletionReason").value.trim();
      const { error } = await supabase.from("account_deletion_requests").insert({ reason: reason || null });
      if (error) throw error;
      feedback.style.color = "var(--success,#28734a)";
      feedback.textContent = "تم إرسال طلبك إلى المالك. سيبقى حسابك نشطًا حتى تتم مراجعته.";
      document.getElementById("accountDeletionReason").value = "";
    } catch (err) {
      feedback.style.color = "var(--danger,#a33b32)";
      feedback.textContent = err.code === "42P01" || err.code === "PGRST205"
        ? "ميزة الطلب تحتاج إلى تشغيل migration_account_messaging.sql في Supabase."
        : `تعذر إرسال الطلب: ${err.message || "خطأ غير معروف"}`;
    } finally { deleteRequestButton.disabled = false; }
  };

  document.getElementById("accountLogoutBtn").onclick = async () => {
    await supabase.auth.signOut();
    state.session = null;
    state.user = null;
    state.role = "student";
    state.uploaderGroup = null;
    state.filesCache = [];
    state.teacherInfoCache = [];
    state.renderedUserId = null;
    location.hash = "#/";
    renderLoggedOut("تم تسجيل الخروج بنجاح.");
  };
}

// 22. PAGE: 404 NOT FOUND
function renderNotFoundView(page) {
  page.innerHTML = `
    <div class="content-card" style="text-align: center; padding: 60px 20px;">
      <div class="mono" style="font-size: 64px; font-weight: 500; color: var(--brown); margin-bottom: 12px;">404</div>
      <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">الصفحة غير موجودة</h2>
      <p style="color: var(--muted); margin-bottom: 24px;">الرابط الذي طلبته غير موجود أو تم نقله.</p>
      <a href="#/" class="btn-primary" style="display: inline-block; width: auto; text-decoration: none;">العودة للرئيسية</a>
    </div>
  `;
}

// 23. HASH CHANGE LISTENER
function updateSidebarActiveRoute(hash) {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav) return;
  nav.querySelectorAll(".nav-link").forEach(link => {
    const href = link.getAttribute("href") || "";
    const active = href === hash
      || (href === "#/groupes" && hash.startsWith("#/groupe/"))
      || (href === "#/teachers" && hash.startsWith("#/teacher/"));
    link.classList.toggle("active", active);
    if (active) {
      const section = link.closest("details.nav-section");
      if (section) section.open = true;
    }
  });
  nav.querySelectorAll("details.nav-section").forEach(section => {
    if (!section.querySelector(".nav-link.active")) section.open = false;
  });
}

window.addEventListener("hashchange", () => {
  if (recoveryMode) return;
  const hash = normalizeHash(location.hash);
  if (hash !== "#/messages" && activeGroupChatChannel) {
    supabase.removeChannel(activeGroupChatChannel);
    activeGroupChatChannel = null;
  }
  if (!hash.startsWith("#/")) return;
  if (!state.user) {
    if (hash !== "#/") {
      state.redirectAfterLogin = hash;
      location.hash = "#/";
      renderLoggedOut("سجّل الدخول باش تكمل.");
    }
    return;
  }
  const page = document.getElementById("pageContent");
  if (page) {
    state.currentRoute = hash;
    dispatchRoute(hash);
    updateSidebarActiveRoute(hash);
    const sidebar = document.getElementById("appSidebar");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (sidebar) sidebar.classList.remove("open");
    if (backdrop) backdrop.classList.remove("open");
    state.sidebarOpen = false;
  } else {
    renderApp();
  }
});
