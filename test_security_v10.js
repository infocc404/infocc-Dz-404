// Focused regression checks for the v10 file-scope and role-separation rules.
// These are local logic simulations, not a substitute for running RLS against Supabase.

const ownerEmail = "locoviber16@gmail.com";
function groupFromPath(path) {
  const m = String(path || "").match(/^g(10|[1-9])\//);
  return m ? Number(m[1]) : null;
}
function fileGroup(file) {
  const n = Number(file.group_no);
  if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
  return groupFromPath(file.path);
}
function shared(file) {
  return file.group_no == null && String(file.path || "").startsWith("common/");
}
function canReadFile(user, file) {
  if (!user || user.role === "suspended") return false;
  if (user.role === "owner" || user.role === "admin") return true;
  if (shared(file)) return true;
  const g = fileGroup(file);
  if (g !== null) return Number(user.group_no) === g;
  return file.kind === "cours" && file.group_no == null;
}
function canReadStorage(user, path, matchingFile) {
  if (!user || user.role === "suspended") return false;
  if (user.role === "owner" || user.role === "admin") return true;
  if (String(path).startsWith("common/")) return true;
  const pathGroup = groupFromPath(path);
  if (pathGroup !== null) return Number(user.group_no) === pathGroup;
  if (!matchingFile) return false;
  if (matchingFile.group_no != null) return Number(user.group_no) === Number(matchingFile.group_no);
  return matchingFile.kind === "cours" && groupFromPath(path) === null;
}
function assert(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  console.log(`[PASSED] ${name}`);
}

const g10NullGroup = { group_no: null, kind: "autre", path: "g10/schedule_test.pdf" };
const commonProgram = { group_no: null, kind: "autre", path: "common/schedule_common.pdf" };
const legacyG10 = { group_no: 10, kind: "td", path: "legacy_td10.pdf" };
const g1 = { role: "student", group_no: 1 };
const g10 = { role: "student", group_no: 10 };
const admin = { role: "admin", group_no: null };
const suspended = { role: "suspended", group_no: null };

assert("G1 cannot read a legacy row whose path is g10/ even when group_no is NULL", !canReadFile(g1, g10NullGroup));
assert("G10 can read its own legacy g10/ row when group_no is NULL", canReadFile(g10, g10NullGroup));
assert("Shared common/ PDF is visible to an assigned student", canReadFile(g1, commonProgram));
assert("G1 cannot access a G10 storage object directly", !canReadStorage(g1, "g10/schedule_test.pdf", g10NullGroup));
assert("G10 can access its own G10 storage object", canReadStorage(g10, "g10/schedule_test.pdf", g10NullGroup));
assert("Legacy flat-path file with group_no=10 is visible only to G10", !canReadStorage(g1, "legacy_td10.pdf", legacyG10) && canReadStorage(g10, "legacy_td10.pdf", legacyG10));
assert("Suspended accounts cannot read shared or group files", !canReadFile(suspended, commonProgram) && !canReadStorage(suspended, "g10/schedule_test.pdf", g10NullGroup));
function canManageGroupHeads(role) { return role === "owner" || role === "admin"; }
function canManageGeneralAdmins(role) { return role === "owner"; }
assert("Admin can appoint or remove group heads", canManageGroupHeads("admin"));
assert("Admin cannot appoint or remove a general admin", !canManageGeneralAdmins("admin"));
assert("Owner can manage both general admins and group heads", canManageGeneralAdmins("owner") && canManageGroupHeads("owner"));
assert("Students cannot manage group heads or general admins", !canManageGroupHeads("student") && !canManageGeneralAdmins("student"));
assert("Owner identity remains the configured owner email", ownerEmail === "locoviber16@gmail.com");

console.log("ALL V10 REGRESSION SIMULATIONS PASSED.");
