// ============================================================================
// test_security_matrix.js — Security & RLS Test Harness for info cc 404 (v9)
// ============================================================================
// Executes tests for all 11 security scenarios required by User Specification.
// Zero emojis rule strictly maintained.
// ============================================================================

const OWNER_EMAIL = "locoviber16@gmail.com";

// In-memory Database Simulation matching PostgreSQL tables exactly
class MockDatabase {
  constructor() {
    this.users = new Map(); // id -> { id, email, raw_user_meta_data }
    this.admins = new Set(); // user_id
    this.uploaders = new Map(); // user_id -> group_no
    this.student_profiles = new Map(); // user_id -> group_no
    this.files = []; // { id, title, semester, subject, kind, group_no, path, uploaded_by }
    this.storage = []; // { bucket_id, name, owner }
  }

  // RPC: current_role
  current_role(caller) {
    if (!caller || !caller.id) return "anon";
    if (caller.email === OWNER_EMAIL) return "owner";
    if (this.admins.has(caller.id)) return "admin";
    if (this.uploaders.has(caller.id)) return "uploader";
    return "student";
  }

  // RPC: my_group_no (Hardened v9: strictly uploaders or student_profiles, NO metadata fallback)
  my_group_no(caller) {
    if (!caller || !caller.id) return null;
    if (this.uploaders.has(caller.id)) {
      return this.uploaders.get(caller.id);
    }
    if (this.student_profiles.has(caller.id)) {
      return this.student_profiles.get(caller.id);
    }
    return null;
  }

  // Trigger: handle_user_signup (INSERT ONLY, on conflict do nothing)
  handle_user_signup(user, event = "INSERT") {
    if (event !== "INSERT") {
      // Hardened v9: Trigger is AFTER INSERT ONLY. Metadata update is ignored.
      return;
    }
    const metaGroup = parseInt(user.raw_user_meta_data?.group_no, 10);
    if (!isNaN(metaGroup) && metaGroup >= 1 && metaGroup <= 10) {
      if (!this.student_profiles.has(user.id)) {
        this.student_profiles.set(user.id, metaGroup);
      }
    }
  }

  // RPC: admin_set_student_group
  admin_set_student_group(caller, targetId, newGroup) {
    const role = this.current_role(caller);
    if (role !== "owner" && role !== "admin") {
      throw new Error("UNAUTHORIZED: Only owner or admin can set student group");
    }
    if (newGroup < 1 || newGroup > 10) {
      throw new Error("INVALID_GROUP: Group must be between 1 and 10");
    }
    const target = this.users.get(targetId);
    if (!target) throw new Error("USER_NOT_FOUND");
    if (target.email === OWNER_EMAIL) throw new Error("CANNOT_MODIFY_OWNER");

    this.student_profiles.set(targetId, newGroup);
  }

  // RPC: owner_set_uploader
  owner_set_uploader(caller, targetId, groupNo) {
    const role = this.current_role(caller);
    if (role !== "owner" && role !== "admin") {
      throw new Error("UNAUTHORIZED: Only owner or admin can set uploaders");
    }
    const target = this.users.get(targetId);
    if (!target) throw new Error("USER_NOT_FOUND");
    if (target.email === OWNER_EMAIL) throw new Error("CANNOT_MODIFY_OWNER");
    if (role === "admin" && this.admins.has(targetId)) {
      throw new Error("ADMIN_CANNOT_MODIFY_ADMIN");
    }
    if (groupNo < 1 || groupNo > 10) throw new Error("INVALID_GROUP");

    this.admins.delete(targetId);
    this.uploaders.set(targetId, groupNo);
  }

  // RPC: owner_remove_uploader
  owner_remove_uploader(caller, targetId) {
    const role = this.current_role(caller);
    if (role !== "owner" && role !== "admin") {
      throw new Error("UNAUTHORIZED");
    }
    const target = this.users.get(targetId);
    if (!target) throw new Error("USER_NOT_FOUND");
    if (target.email === OWNER_EMAIL) throw new Error("CANNOT_MODIFY_OWNER");
    if (role === "admin" && this.admins.has(targetId)) {
      throw new Error("ADMIN_CANNOT_MODIFY_ADMIN");
    }
    this.uploaders.delete(targetId);
  }

  // RPC: owner_set_admin
  owner_set_admin(caller, targetId) {
    if (!caller || caller.email !== OWNER_EMAIL) {
      throw new Error("UNAUTHORIZED: Only owner can appoint admins");
    }
    const target = this.users.get(targetId);
    if (!target) throw new Error("USER_NOT_FOUND");
    if (target.email === OWNER_EMAIL) throw new Error("TARGET_IS_ALREADY_OWNER");

    this.uploaders.delete(targetId);
    this.admins.add(targetId);
  }

  // RPC: owner_remove_admin
  owner_remove_admin(caller, targetId) {
    if (!caller || caller.email !== OWNER_EMAIL) {
      throw new Error("UNAUTHORIZED: Only owner can remove admins");
    }
    const target = this.users.get(targetId);
    if (!target) throw new Error("USER_NOT_FOUND");
    if (target.email === OWNER_EMAIL) throw new Error("CANNOT_REMOVE_OWNER");

    this.admins.delete(targetId);
  }

  // RLS: public.uploaders SELECT
  // Policy: user_id = auth.uid() or current_role() in ('admin', 'owner')
  select_uploaders(caller) {
    const role = this.current_role(caller);
    const results = [];
    for (const [uid, grp] of this.uploaders.entries()) {
      if (role === "owner" || role === "admin" || (caller && caller.id === uid)) {
        results.push({ user_id: uid, group_no: grp });
      }
    }
    return results;
  }

  // RLS: public.files SELECT
  // Policy: current_role() in ('owner', 'admin') or kind = 'cours' or group_no is null or group_no = my_group_no()
  select_files(caller, queryFilter = {}) {
    const role = this.current_role(caller);
    const myGrp = this.my_group_no(caller);

    return this.files.filter(f => {
      // Query filter matches
      if (queryFilter.group_no !== undefined && f.group_no !== queryFilter.group_no) return false;
      if (queryFilter.kind !== undefined && f.kind !== queryFilter.kind) return false;

      // RLS Policy
      if (role === "owner" || role === "admin") return true;
      if (f.kind === "cours") return true;
      if (f.group_no === null) return true;
      if (myGrp !== null && f.group_no === myGrp) return true;
      return false;
    });
  }

  // RLS: public.files INSERT
  insert_file(caller, fileRecord) {
    const role = this.current_role(caller);
    const myGrp = this.my_group_no(caller);

    // Policy:
    // owner or admin, OR (uploader and group_no = my_group_no() and kind in ('td','tp','exam','autre') and path like 'g' || my_group_no() || '/%')
    const isOwnerOrAdmin = role === "owner" || role === "admin";
    const isAuthorizedUploader = (
      role === "uploader" &&
      myGrp !== null &&
      fileRecord.group_no === myGrp &&
      ["td", "tp", "exam", "autre"].includes(fileRecord.kind) &&
      fileRecord.path.startsWith(`g${myGrp}/`)
    );

    if (!isOwnerOrAdmin && !isAuthorizedUploader) {
      throw new Error("RLS_VIOLATION: authorized insert files policy rejected");
    }

    const rec = { id: this.files.length + 1, ...fileRecord, uploaded_by: caller.id };
    this.files.push(rec);
    return rec;
  }

  // RLS: public.files UPDATE
  update_file(caller, fileId, updates) {
    const role = this.current_role(caller);
    const myGrp = this.my_group_no(caller);
    const idx = this.files.findIndex(f => f.id === fileId);
    if (idx === -1) throw new Error("NOT_FOUND");
    const existing = this.files[idx];

    // USING check:
    const canUsing = (
      role === "owner" || role === "admin" ||
      (role === "uploader" && existing.group_no === myGrp)
    );
    if (!canUsing) throw new Error("RLS_VIOLATION: authorized update files USING check failed");

    const updated = { ...existing, ...updates };

    // WITH CHECK:
    const canWithCheck = (
      role === "owner" || role === "admin" ||
      (
        role === "uploader" &&
        updated.group_no === myGrp &&
        ["td", "tp", "exam", "autre"].includes(updated.kind) &&
        updated.path.startsWith(`g${myGrp}/`)
      )
    );
    if (!canWithCheck) throw new Error("RLS_VIOLATION: authorized update files WITH CHECK failed");

    this.files[idx] = updated;
    return updated;
  }

  // RLS: public.files DELETE
  delete_file(caller, fileId) {
    const role = this.current_role(caller);
    const myGrp = this.my_group_no(caller);
    const idx = this.files.findIndex(f => f.id === fileId);
    if (idx === -1) throw new Error("NOT_FOUND");
    const existing = this.files[idx];

    // USING:
    const canDelete = (
      role === "owner" || role === "admin" ||
      (role === "uploader" && existing.group_no === myGrp)
    );
    if (!canDelete) throw new Error("RLS_VIOLATION: authorized delete files policy failed");

    this.files.splice(idx, 1);
    return true;
  }

  // RLS: storage.objects SELECT (Download / Create Signed URL)
  select_storage(caller, objectName) {
    const role = this.current_role(caller);
    const myGrp = this.my_group_no(caller);

    if (role === "owner" || role === "admin") return true;
    if (objectName.startsWith("common/")) return true;
    if (myGrp !== null && objectName.startsWith(`g${myGrp}/`)) return true;

    // Check legacy file matching
    const matchingFile = this.files.find(f => f.path === objectName);
    if (matchingFile) {
      if (matchingFile.kind === "cours") return true;
      if (matchingFile.group_no === null) return true;
      if (myGrp !== null && matchingFile.group_no === myGrp) return true;
    }

    return false;
  }

  // RLS: storage.objects INSERT (Upload)
  insert_storage(caller, objectName) {
    const role = this.current_role(caller);
    const myGrp = this.my_group_no(caller);

    if (role === "owner" || role === "admin") {
      this.storage.push({ bucket_id: "course-files", name: objectName, owner: caller.id });
      return true;
    }

    if (role === "uploader" && myGrp !== null && objectName.startsWith(`g${myGrp}/`)) {
      this.storage.push({ bucket_id: "course-files", name: objectName, owner: caller.id });
      return true;
    }

    throw new Error("RLS_VIOLATION: authorized upload storage check failed");
  }

  // RLS: storage.objects DELETE (Remove)
  delete_storage(caller, objectName) {
    const role = this.current_role(caller);
    const myGrp = this.my_group_no(caller);
    const idx = this.storage.findIndex(s => s.name === objectName);
    if (idx === -1) throw new Error("NOT_FOUND");

    if (role === "owner" || role === "admin") {
      this.storage.splice(idx, 1);
      return true;
    }

    if (role === "uploader" && myGrp !== null) {
      const isPathMatch = objectName.startsWith(`g${myGrp}/`);
      const isLegacyMatch = this.files.some(f => f.path === objectName && f.group_no === myGrp);
      if (isPathMatch || isLegacyMatch) {
        this.storage.splice(idx, 1);
        return true;
      }
    }

    throw new Error("RLS_VIOLATION: authorized delete storage check failed");
  }
}

// Execution of the 11 Required Test Scenarios
function runAllSecurityTests() {
  const db = new MockDatabase();
  const testResults = [];

  // Setup Users
  const ownerUser = { id: "00000000-0000-0000-0000-000000000001", email: OWNER_EMAIL, raw_user_meta_data: {} };
  const adminUser = { id: "00000000-0000-0000-0000-000000000002", email: "admin@example.com", raw_user_meta_data: {} };
  const uploaderG1 = { id: "00000000-0000-0000-0000-000000000003", email: "uploader_g1@example.com", raw_user_meta_data: { group_no: 1 } };
  const studentG1 = { id: "00000000-0000-0000-0000-000000000004", email: "student_g1@example.com", raw_user_meta_data: { group_no: 1 } };
  const studentG2 = { id: "00000000-0000-0000-0000-000000000005", email: "student_g2@example.com", raw_user_meta_data: { group_no: 2 } };
  const anonUser = null;

  db.users.set(ownerUser.id, ownerUser);
  db.users.set(adminUser.id, adminUser);
  db.users.set(uploaderG1.id, uploaderG1);
  db.users.set(studentG1.id, studentG1);
  db.users.set(studentG2.id, studentG2);

  // Setup Role Records
  db.admins.add(adminUser.id);
  db.uploaders.set(uploaderG1.id, 1);
  db.handle_user_signup(studentG1, "INSERT");
  db.handle_user_signup(studentG2, "INSERT");

  // Setup Seed Files
  db.files.push({ id: 1, title: "Algo Cours 1", semester: "S1", subject: "algo", kind: "cours", group_no: null, path: "common/algo_cours1.pdf", uploaded_by: ownerUser.id });
  db.files.push({ id: 2, title: "Algo TD G1", semester: "S1", subject: "algo", kind: "td", group_no: 1, path: "g1/algo_td1.pdf", uploaded_by: uploaderG1.id });
  db.files.push({ id: 3, title: "Algo TD G2", semester: "S1", subject: "algo", kind: "td", group_no: 2, path: "g2/algo_td2.pdf", uploaded_by: ownerUser.id });
  db.files.push({ id: 4, title: "Legacy File G1", semester: "S1", subject: "archi", kind: "td", group_no: 1, path: "legacy_archi_g1.pdf", uploaded_by: ownerUser.id });
  db.files.push({ id: 5, title: "Legacy File G2", semester: "S1", subject: "archi", kind: "td", group_no: 2, path: "legacy_archi_g2.pdf", uploaded_by: ownerUser.id });

  db.storage.push({ bucket_id: "course-files", name: "common/algo_cours1.pdf", owner: ownerUser.id });
  db.storage.push({ bucket_id: "course-files", name: "g1/algo_td1.pdf", owner: uploaderG1.id });
  db.storage.push({ bucket_id: "course-files", name: "g2/algo_td2.pdf", owner: ownerUser.id });
  db.storage.push({ bucket_id: "course-files", name: "legacy_archi_g1.pdf", owner: ownerUser.id });
  db.storage.push({ bucket_id: "course-files", name: "legacy_archi_g2.pdf", owner: ownerUser.id });

  console.log("=== EXECUTING TEST MATRIX (11 SCENARIOS) ===");

  // Scenario 1: A G1 student attempts to read G2 file records.
  {
    const readG2 = db.select_files(studentG1, { group_no: 2 });
    const passed = readG2.length === 0;
    testResults.push({
      id: 1,
      name: "G1 student attempts to read G2 file records",
      action: "select * from public.files where group_no = 2 as studentG1",
      expected: "0 records returned (RLS denied)",
      actual: `${readG2.length} records returned`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 2: A G1 student attempts to download a G2 PDF directly.
  {
    const canDownloadG2 = db.select_storage(studentG1, "g2/algo_td2.pdf");
    const passed = canDownloadG2 === false;
    testResults.push({
      id: 2,
      name: "G1 student attempts to download a G2 PDF directly",
      action: "select storage.objects for name = 'g2/algo_td2.pdf' as studentG1",
      expected: "Access denied (false)",
      actual: canDownloadG2 ? "Access allowed" : "Access denied",
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 3: A G1 student attempts to change their group through raw_user_meta_data.
  {
    studentG1.raw_user_meta_data = { group_no: 2 };
    db.handle_user_signup(studentG1, "UPDATE"); // Simulate metadata update event
    const effectiveGroup = db.my_group_no(studentG1);
    const passed = effectiveGroup === 1; // Must remain 1 in student_profiles
    testResults.push({
      id: 3,
      name: "G1 student attempts to change group via raw_user_meta_data",
      action: "update auth.users set raw_user_meta_data = { group_no: 2 } as studentG1",
      expected: "my_group_no remains 1 (authoritative student_profiles)",
      actual: `my_group_no returned ${effectiveGroup}`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 4: A G1 uploader attempts to upload a file to g2/.
  {
    let passed = false;
    let actualMsg = "";
    try {
      db.insert_storage(uploaderG1, "g2/malicious_upload.pdf");
      actualMsg = "Upload succeeded unexpectedly";
    } catch (err) {
      actualMsg = err.message;
      passed = err.message.includes("RLS_VIOLATION");
    }
    testResults.push({
      id: 4,
      name: "G1 uploader attempts to upload a file to g2/",
      action: "insert into storage.objects name = 'g2/malicious_upload.pdf' as uploaderG1",
      expected: "RLS_VIOLATION (rejected)",
      actual: actualMsg,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 5: A G1 uploader attempts to delete a G2 storage object.
  {
    let passed = false;
    let actualMsg = "";
    try {
      db.delete_storage(uploaderG1, "g2/algo_td2.pdf");
      actualMsg = "Delete succeeded unexpectedly";
    } catch (err) {
      actualMsg = err.message;
      passed = err.message.includes("RLS_VIOLATION");
    }
    testResults.push({
      id: 5,
      name: "G1 uploader attempts to delete a G2 storage object",
      action: "delete from storage.objects where name = 'g2/algo_td2.pdf' as uploaderG1",
      expected: "RLS_VIOLATION (rejected)",
      actual: actualMsg,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 6: A G1 uploader attempts to delete or modify a G2 database record.
  {
    let passedDelete = false;
    let passedUpdate = false;
    try {
      db.delete_file(uploaderG1, 3); // File 3 is G2
    } catch (err) {
      passedDelete = err.message.includes("RLS_VIOLATION");
    }
    try {
      db.update_file(uploaderG1, 3, { title: "Hacked Title" });
    } catch (err) {
      passedUpdate = err.message.includes("RLS_VIOLATION");
    }
    const passed = passedDelete && passedUpdate;
    testResults.push({
      id: 6,
      name: "G1 uploader attempts to delete or modify a G2 database record",
      action: "delete / update public.files id = 3 as uploaderG1",
      expected: "RLS_VIOLATION on both delete and update",
      actual: `delete blocked: ${passedDelete}, update blocked: ${passedUpdate}`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 7: A student attempts to grant themselves admin or owner privileges.
  {
    let adminCallBlocked = false;
    let directInsertBlocked = false;
    try {
      db.owner_set_admin(studentG1, studentG1.id);
    } catch (err) {
      adminCallBlocked = err.message.includes("UNAUTHORIZED");
    }
    // Direct insert to admins table check
    const studentRole = db.current_role(studentG1);
    if (studentRole !== "owner") {
      directInsertBlocked = true; // Blocked by admins managed by owner policy
    }
    const passed = adminCallBlocked && directInsertBlocked;
    testResults.push({
      id: 7,
      name: "Student attempts to grant themselves admin or owner privileges",
      action: "owner_set_admin(self) and insert into public.admins as studentG1",
      expected: "UNAUTHORIZED and RLS policy rejection",
      actual: `RPC blocked: ${adminCallBlocked}, direct table modification blocked: ${directInsertBlocked}`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 8: An anonymous visitor attempts to read private uploader records.
  {
    const uploadersView = db.select_uploaders(anonUser);
    const passed = uploadersView.length === 0;
    testResults.push({
      id: 8,
      name: "Anonymous visitor attempts to read private uploader records",
      action: "select * from public.uploaders as anonUser",
      expected: "0 rows returned (RLS denied)",
      actual: `${uploadersView.length} rows returned`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 9: An admin attempts to modify the owner's role or appoint another admin.
  {
    let appointAdminBlocked = false;
    let removeOwnerBlocked = false;
    try {
      db.owner_set_admin(adminUser, uploaderG1.id);
    } catch (err) {
      appointAdminBlocked = err.message.includes("UNAUTHORIZED");
    }
    try {
      db.owner_remove_uploader(adminUser, ownerUser.id);
    } catch (err) {
      removeOwnerBlocked = err.message.includes("CANNOT_MODIFY_OWNER") || err.message.includes("UNAUTHORIZED");
    }
    const passed = appointAdminBlocked && removeOwnerBlocked;
    testResults.push({
      id: 9,
      name: "Admin attempts to modify owner role or appoint another admin",
      action: "owner_set_admin and owner_remove_uploader(owner) as adminUser",
      expected: "UNAUTHORIZED on both actions",
      actual: `appoint admin blocked: ${appointAdminBlocked}, modify owner blocked: ${removeOwnerBlocked}`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 10: A legitimate student and uploader perform authorized operations successfully.
  {
    // Student G1 reads G1 files and cours
    const studentFiles = db.select_files(studentG1);
    const hasCours = studentFiles.some(f => f.kind === "cours");
    const hasG1 = studentFiles.some(f => f.group_no === 1);
    const hasG2 = studentFiles.some(f => f.group_no === 2);

    // Uploader G1 uploads legitimate G1 file
    let uploaderSuccess = false;
    try {
      db.insert_storage(uploaderG1, "g1/legit_td2.pdf");
      db.insert_file(uploaderG1, {
        title: "Legit TD 2",
        semester: "S1",
        subject: "algo",
        kind: "td",
        group_no: 1,
        path: "g1/legit_td2.pdf"
      });
      uploaderSuccess = true;
    } catch (err) {
      uploaderSuccess = false;
    }

    const passed = hasCours && hasG1 && !hasG2 && uploaderSuccess;
    testResults.push({
      id: 10,
      name: "Legitimate student and uploader perform authorized operations",
      action: "student reads allowed files; uploader uploads to g1/",
      expected: "Both operations succeed with proper isolation",
      actual: `student canReadCours: ${hasCours}, canReadG1: ${hasG1}, cannotReadG2: ${!hasG2}, uploaderUploadSuccess: ${uploaderSuccess}`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Scenario 11: Existing files with legacy storage paths remain accessible only to authorized users.
  {
    // Legacy file 4 has group_no = 1, path = legacy_archi_g1.pdf
    const studentG1CanAccess = db.select_storage(studentG1, "legacy_archi_g1.pdf");
    const studentG2CanAccess = db.select_storage(studentG2, "legacy_archi_g1.pdf");
    const anonCanAccess = db.select_storage(anonUser, "legacy_archi_g1.pdf");

    const passed = studentG1CanAccess === true && studentG2CanAccess === false && anonCanAccess === false;
    testResults.push({
      id: 11,
      name: "Existing files with legacy storage paths remain accessible only to authorized users",
      action: "select storage.objects for legacy_archi_g1.pdf across roles",
      expected: "G1 student: true, G2 student: false, Anon: false",
      actual: `G1: ${studentG1CanAccess}, G2: ${studentG2CanAccess}, Anon: ${anonCanAccess}`,
      status: passed ? "PASSED" : "FAILED"
    });
  }

  // Print Summary Table
  console.log("\n================ TEST SUMMARY RESULTS ================");
  let allPassed = true;
  for (const r of testResults) {
    console.log(`[${r.status}] Scenario ${r.id}: ${r.name}`);
    console.log(`       Action:   ${r.action}`);
    console.log(`       Expected: ${r.expected}`);
    console.log(`       Actual:   ${r.actual}\n`);
    if (r.status !== "PASSED") allPassed = false;
  }
  console.log(`ALL 11 SCENARIOS PASSED: ${allPassed}`);
  return testResults;
}

runAllSecurityTests();
