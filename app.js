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

// XSS Sanitizer
function escapeHtml(str) {
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
      state.studentGroup = data[0]?.assigned_group ?? null;
    } else if (typeof data === "object" && data !== null) {
      state.role = data.user_role || "student";
      state.uploaderGroup = data.uploader_group ?? null;
      state.studentGroup = data.assigned_group ?? null;
    } else if (typeof data === "string") {
      state.role = data;
      state.uploaderGroup = null;
      state.studentGroup = null;
    } else {
      state.role = "student";
      state.uploaderGroup = null;
      state.studentGroup = null;
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

// 7. LOGGED-OUT VIEW RENDERER
function renderLoggedOut(errorMessage = "", successMessage = "") {
  rootEl.innerHTML = `
    <div class="auth-container">
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

            <div class="form-group">
              <label class="form-label" for="signupGroup">فوجك الدراسي *</label>
              <select id="signupGroup" class="form-control mono" required>
                <option value="" disabled selected>اختر فوجك (إلزامي)...</option>
                ${[1,2,3,4,5,6,7,8,9,10].map(g => `<option value="${g}">G${g}</option>`).join("")}
              </select>
            </div>

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
    const groupVal = document.getElementById("signupGroup").value;

    if (!groupVal) {
      alert("يرجى اختيار الفوج الدراسي (إلزامي).");
      return;
    }

    const groupNo = parseInt(groupVal, 10);
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
        data: { group_no: groupNo }
      }
    });

    if (error) {
      renderLoggedOut(translateAuthError(error.message));
    } else if (data?.user && !data?.session) {
      // Email confirmation is ON: the user must confirm before logging in.
      renderLoggedOut("", "تم إنشاء الحساب. افتح رسالة التأكيد في بريدك (وتحقق من الرسائل غير المرغوب فيها) ثم سجّل الدخول.");
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

  // Build shell
  rootEl.innerHTML = `
    <div class="app-container">
      <!-- Backdrop for mobile -->
      <div id="sidebarBackdrop" class="sidebar-backdrop"></div>

      <!-- Right Sidebar -->
      <aside id="appSidebar" class="app-sidebar">
        <div class="sidebar-header">
          <span class="logo-badge-small mono">404</span>
          <span class="sidebar-brand-name mono">info_cc_404</span>
        </div>

        <nav class="sidebar-nav">
          <a href="#/" class="nav-link ${hash === "#/" ? "active" : ""}">
            <span>الرئيسية</span>
          </a>
          <a href="#/groupes" class="nav-link ${hash.startsWith("#/groupe") ? "active" : ""}">
            <span>الأفواج</span>
          </a>
          <a href="#/horaire" class="nav-link ${hash === "#/horaire" ? "active" : ""}">
            <span>الجدول الزمني</span>
          </a>
          <a href="#/teachers" class="nav-link ${hash.startsWith("#/teacher") ? "active" : ""}">
            <span>الأساتذة</span>
          </a>
          ${
            isOwner || isAdmin || isUploader
              ? `<a href="#/upload" class="nav-link ${hash === "#/upload" ? "active" : ""}">
                  <span>رفع الملفات</span>
                 </a>`
              : ""
          }
          ${
            isOwner || isAdmin
              ? `<a href="#/admin" class="nav-link ${hash === "#/admin" ? "active" : ""}">
                  <span>الإدارة</span>
                 </a>`
              : ""
          }
          ${isOwner ? `<a href="#/owner-users" class="nav-link ${hash === "#/owner-users" ? "active" : ""}"><span>لوحة المالك</span></a>` : ""}
          <a href="#/compte" class="nav-link ${hash === "#/compte" ? "active" : ""}">
            <span>حسابي</span>
          </a>
        </nav>

        <div class="sidebar-footer">
          <button type="button" class="btn-secondary" id="sidebarLogoutBtn" style="width: 100%;">
            تسجيل الخروج
          </button>
        </div>
      </aside>

      <!-- Main Area -->
      <div class="app-main">
        <!-- Top Bar -->
        <header class="app-topbar">
          <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
            <button type="button" id="mobileMenuBtn" class="mobile-menu-btn" aria-label="القائمة">
              القائمة
            </button>

            <!-- Search box -->
            <div class="search-box-wrapper">
              <input type="text" id="topSearchInput" class="search-input" placeholder="ابحث في عناوين الملفات المتاحة...">
              <div id="searchResultsDropdown" class="search-results-dropdown"></div>
            </div>
          </div>

          <div class="topbar-right-info">
            <span class="role-badge ${state.role}">
              ${getRoleBadgeText(state.role, state.uploaderGroup)}
            </span>
            <div class="user-avatar-circle" id="topbarAvatar" title="${escapeHtml(state.user.email)}">
              ${escapeHtml(state.user.email?.[0]?.toUpperCase() || "U")}
            </div>
          </div>
        </header>

        <!-- Route Content Area -->
        <main class="page-body" id="pageContent">
          <!-- Injected Route View -->
        </main>
      </div>
    </div>
  `;

  attachShellEvents();
  dispatchRoute(hash);
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

function attachShellEvents() {
  const sidebar = document.getElementById("appSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const menuBtn = document.getElementById("mobileMenuBtn");
  const logoutBtn = document.getElementById("sidebarLogoutBtn");
  const avatar = document.getElementById("topbarAvatar");
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
    avatar.onclick = () => {
      location.hash = "#/compte";
    };
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
function dispatchRoute(hash) {
  const page = document.getElementById("pageContent");
  if (!page) return;

  // #/
  if (hash === "#/") {
    renderHomeView(page);
    return;
  }

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
    if (state.role !== "owner" && state.role !== "admin") {
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

function renderAccessDenied(page) {
  page.innerHTML = `
    <div class="content-card" style="text-align: center; padding: 40px;">
      <h2 style="font-size: 20px; font-weight: 600; color: var(--danger); margin-bottom: 8px;">ما عندكش الصلاحية</h2>
      <p style="color: var(--muted); margin-bottom: 20px;">هذه الصفحة مخصصة لمالك المنصة فقط.</p>
      <a href="#/" class="btn-primary" style="display: inline-block; width: auto;">العودة للرئيسية</a>
    </div>
  `;
}

// 12. PAGE: HOME (#/)
function renderHomeView(page) {
  const sg = state.studentGroup;
  const recentFiles = getAccessibleFiles().slice(0, 5);

  page.innerHTML = `
    <div class="page-banner">
      <h2>مرحباً بك، ${escapeHtml(state.user.email?.split("@")[0] || "طالب")}</h2>
      <p>منصة info cc 404 لمشاركة وتصفح ملفات الإعلام الآلي (الدفعة الأولى).</p>
    </div>

    ${!sg && state.role === "student" ? `
      <div class="content-card" style="border:1px solid var(--brown);background:var(--cream, #fbf7f0);margin-bottom:16px;">
        <h3 style="font-size:16px;font-weight:700;color:var(--brown-dark);margin-bottom:6px;">لم يتم تعيين فوجك بعد</h3>
        <p style="font-size:13px;color:var(--muted);line-height:1.8;margin-bottom:12px;">افتح «حسابي»، واختر الفوج الذي تدرس فيه، ثم أرسل طلبًا للإدارة. ستظهر ملفات فوجك بعد موافقة المالك أو المشرف.</p>
        <a href="#/compte" class="btn-primary" style="display:inline-block;width:auto;text-decoration:none;padding:9px 16px;">اختيار الفوج وإرسال الطلب</a>
      </div>
    ` : ''}

    <!-- 3 Shortcut Cards -->
    <div class="welcome-grid">
      <a href="${sg ? `#/groupe/${sg}` : '#/groupes'}" class="shortcut-card">
        <div class="title">${sg ? `فوجي (<span class="mono">G${sg}</span>)` : 'الأفواج الدراسية'}</div>
        <div class="desc">${sg ? 'دروس، أعمال موجهة وتطبيقية خاصة بفوجك.' : 'تصفح المحاضرات والملفات الدراسية.'}</div>
      </a>
      <a href="#/groupes" class="shortcut-card">
        <div class="title">الأفواج</div>
        <div class="desc">تصفح ملفات وتفاصيل جميع الأفواج من G1 إلى G10.</div>
      </a>
      <a href="#/horaire" class="shortcut-card">
        <div class="title">الجدول الزمني</div>
        <div class="desc">البرنامج الأسبوعي وتوزيع الحصص والقاعات.</div>
      </a>
    </div>

    <!-- Chips G1..G10 -->
    <div class="content-card">
      <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 12px; color: var(--brown-dark);">الانتقال المباشر لأي فوج:</h3>
      <div class="chips-wrap" style="margin-bottom: 0;">
        ${[1,2,3,4,5,6,7,8,9,10].map(g => `
          <a href="#/groupe/${g}" class="group-chip-btn ${sg && g === sg ? 'current' : ''}">
            G${g}${sg && g === sg ? ' فوجك' : ''}
          </a>
        `).join("")}
      </div>
    </div>

    <!-- آخر ملفات فوجك -->
    <div class="content-card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark);">${sg ? `آخر ملفات فوجك (G${sg})` : "آخر الملفات"}</h3>
        <span style="font-size: 12px; color: var(--muted);"><span class="mono">${recentFiles.length}</span> ملفات معروضة</span>
      </div>

      ${
        recentFiles.length === 0
          ? `<p style="color: var(--muted); text-align: center; padding: 20px;">ما كاين حتى ملف بعد</p>`
          : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>عنوان الملف</th>
                    <th>المادة</th>
                    <th>النوع</th>
                    <th>التاريخ</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${recentFiles.map(f => {
                    const isNew = isWithinDays(f.created_at, 7);
                    return `
                      <tr>
                        <td>
                          <strong>${escapeHtml(f.title)}</strong>
                          ${isNew ? '<span class="badge-new">جديد</span>' : ''}
                        </td>
                        <td>${escapeHtml(getSubjectObj(normalizeSubjectId(f.subject)).nameEn || getSubjectObj(normalizeSubjectId(f.subject)).nameFr || f.subject)}</td>
                        <td><span class="badge-tag">${escapeHtml(f.kind)}</span></td>
                        <td class="mono" style="font-size: 12px;">${formatDate(f.created_at)}</td>
                        <td>
                          <button type="button" class="btn-secondary view-file-btn" data-id="${f.id}" style="padding: 4px 10px; font-size: 12px;">
                            عرض
                          </button>
                        </td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>
          `
      }
    </div>
  `;

  page.querySelectorAll(".view-file-btn").forEach(btn => {
    btn.onclick = () => {
      const fid = btn.getAttribute("data-id");
      location.hash = `#/voir/${fid}`;
    };
  });
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
  const sg = state.studentGroup;
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

          <button type="button" class="btn-secondary mono" id="pdfZoomOut" style="padding: 4px 10px;">-</button>
          <span style="font-size: 12px;" class="mono" id="pdfZoomLevel">100%</span>
          <button type="button" class="btn-secondary mono" id="pdfZoomIn" style="padding: 4px 10px;">+</button>

          <span style="border-right: 1px solid var(--line); height: 20px; margin: 0 4px;"></span>

          <button type="button" class="btn-primary" id="pdfDownloadBtn" style="padding: 4px 14px; width: auto;">⬇ تحميل الملف</button>
        </div>
      </div>

      <div class="pdf-canvas-container" id="pdfCanvasContainer">
        <div id="pdfLoadingState" style="color: #ffffff; padding: 40px; text-align: center;">جاري تجهيز وعرض الملف...</div>
        <canvas id="pdfCanvas" style="display: none;"></canvas>
        <div id="pdfErrorState" style="display: none; color: #fca5a5; padding: 30px; text-align: center;"></div>
      </div>

      <div class="pdf-viewer-footer-note">
        يمكنك قراءة الملف هنا أو تحميله على هاتفك بزر «تحميل الملف».
      </div>
    </div>
  `;

  const container = document.getElementById("pdfViewerContainer");
  if (container) {
    container.addEventListener("contextmenu", e => e.preventDefault());
  }

  const downloadBtn = document.getElementById("pdfDownloadBtn");
  if (downloadBtn) {
    downloadBtn.onclick = async () => {
      const originalText = downloadBtn.textContent;
      downloadBtn.disabled = true;
      downloadBtn.textContent = "جاري التحضير...";
      try {
        const safeName = String(fileObj.title || "document").replace(/[\\/:*?"<>|]+/g, "_").trim() || "document";
        const { data: dl, error: dlErr } = await supabase.storage
          .from("course-files")
          .createSignedUrl(fileObj.path, 120, { download: `${safeName}.pdf` });
        if (dlErr || !dl?.signedUrl) {
          throw new Error(dlErr?.message || "فشل إنشاء رابط التحميل.");
        }
        const a = document.createElement("a");
        a.href = dl.signedUrl;
        a.download = `${safeName}.pdf`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        alert(`تعذر تحميل الملف: ${err.message || "خطأ غير معروف"}`);
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = originalText;
      }
    };
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
    errBox.innerHTML = `خطأ في المعاينة: ${escapeHtml(msg)}<br><small>إذا ما تنفتحش المعاينة، جرب زر «تحميل الملف» وافتحه من هاتفك.</small>`;
    errBox.style.display = "block";
  }
}

async function loadPdfWithPdfJs(pdfUrl) {
  const loading = document.getElementById("pdfLoadingState");
  const canvas = document.getElementById("pdfCanvas");
  if (!window.pdfjsLib) {
    showPdfError("مكتبة pdf.js غير متوفرة.");
    return;
  }

  try {
    const loadingTask = window.pdfjsLib.getDocument(pdfUrl);
    const pdfDoc = await loadingTask.promise;
    state.activePdfDoc = pdfDoc;
    state.pdfCurrentPage = 1;
    state.pdfTotalPages = pdfDoc.numPages;
    state.pdfScale = 1.2;

    if (loading) loading.style.display = "none";
    if (canvas) canvas.style.display = "block";

    renderPdfPage(state.pdfCurrentPage);

    document.getElementById("pdfPrevPage").onclick = () => {
      if (state.pdfCurrentPage > 1) {
        state.pdfCurrentPage--;
        renderPdfPage(state.pdfCurrentPage);
      }
    };

    document.getElementById("pdfNextPage").onclick = () => {
      if (state.pdfCurrentPage < state.pdfTotalPages) {
        state.pdfCurrentPage++;
        renderPdfPage(state.pdfCurrentPage);
      }
    };

    document.getElementById("pdfZoomIn").onclick = () => {
      state.pdfScale = Math.min(state.pdfScale + 0.2, 2.5);
      document.getElementById("pdfZoomLevel").textContent = `${Math.round(state.pdfScale * 100)}%`;
      renderPdfPage(state.pdfCurrentPage);
    };

    document.getElementById("pdfZoomOut").onclick = () => {
      state.pdfScale = Math.max(state.pdfScale - 0.2, 0.6);
      document.getElementById("pdfZoomLevel").textContent = `${Math.round(state.pdfScale * 100)}%`;
      renderPdfPage(state.pdfCurrentPage);
    };
  } catch (e) {
    showPdfError(e.message || "تعذر تصيير صفحات ملف الـ PDF.");
  }
}

async function renderPdfPage(num) {
  if (!state.activePdfDoc) return;
  const canvas = document.getElementById("pdfCanvas");
  if (!canvas) return;

  const page = await state.activePdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: state.pdfScale });
  const ctx = canvas.getContext("2d");

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  const renderContext = {
    canvasContext: ctx,
    viewport: viewport
  };

  await page.render(renderContext).promise;

  const indicator = document.getElementById("pdfPageIndicator");
  if (indicator) {
    indicator.textContent = `صفحة ${num} / ${state.pdfTotalPages}`;
  }
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
              <td>${isProtectedOwner ? `<span style="color:var(--muted);">محمي</span>` : `<button type="button" class="${suspended ? "btn-primary" : "btn-danger"} owner-user-access-btn" data-user-id="${escapeHtml(userId || "")}" data-action="${suspended ? "restore" : "suspend"}" data-email="${escapeHtml(user.email || "")}" ${!userId ? "disabled" : ""}>${suspended ? "إعادة التفعيل" : "إيقاف الحساب"}</button>`}</td>
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

    <!-- Card 1: Add Section Head (owner and admin; admins cannot manage admins) -->
    <div class="content-card" style="${state.role === "owner" || state.role === "admin" ? "" : "display:none;"}">
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

    <!-- Card 2: Section Heads Table (owner and admin) -->
    <div class="content-card" style="${state.role === "owner" || state.role === "admin" ? "" : "display:none;"}">
      <h3 style="font-size: 16px; font-weight: 600; color: var(--brown-dark); margin-bottom: 8px;">رؤساء الأقسام</h3>
      <p style="font-size: 12px; color: var(--muted); margin-bottom: 14px;">تغيير الدور يتطبق عند تسجيل الدخول القادم للمستخدم.</p>
      
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
    if (state.role !== "owner" && state.role !== "admin") {
      alertErr.textContent = "تعيين رؤساء الأقسام متاح للمالك والمشرف فقط.";
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
    if (state.role !== "owner" && state.role !== "admin") return;
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
            alert(`فشل الإلغاء: ${remErr.message}\n\nإذا كانت الرسالة تقول إن الدالة غير موجودة: شغّل الملف migration_fix_remove_admin_v13.sql في Supabase (SQL Editor).`);
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
          <h3 style="font-size:18px;font-weight:600;color:var(--brown-dark);" class="mono">${escapeHtml(state.user.email)}</h3>
          <span class="role-badge ${state.role}" style="display:inline-block;margin-top:4px;">${getRoleBadgeText(state.role,state.uploaderGroup)}</span>
        </div>
      </div>

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

      <hr style="border:0;border-top:1px solid var(--line);margin:24px 0;">
      <button type="button" class="btn-danger" id="accountLogoutBtn" style="padding:10px 20px;font-size:14px;">تسجيل الخروج من الحساب</button>
    </div>
  `;

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
        requestsContainer.innerHTML = `<div class="table-responsive"><table class="data-table"><thead><tr><th>الفوج الحالي</th><th>الفوج المطلوب</th><th>الحالة</th><th>تاريخ الطلب</th><th>ملاحظة الإدارة</th></tr></thead><tbody>${data.map(r => `<tr><td class="mono">${r.current_group ? `G${r.current_group}` : "غير محدد"}</td><td class="mono">G${r.requested_group}</td><td><span style="color:${statusColors[r.status] || "inherit"};font-weight:600;">${statusLabels[r.status] || escapeHtml(r.status)}</span></td><td class="mono" style="font-size:12px;">${formatDate(r.created_at)}</td><td>${escapeHtml(r.admin_note || "—")}</td></tr>`).join("")}</tbody></table></div>`;
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
window.addEventListener("hashchange", () => {
  if (recoveryMode) return;
  const hash = location.hash;
  if (!hash.startsWith("#/")) {
    return;
  }
  if (!state.user) {
    if (hash !== "#/") {
      state.redirectAfterLogin = hash;
      location.hash = "#/";
      renderLoggedOut("سجّل الدخول باش تكمل.");
    }
    return;
  }
  renderApp();
});
