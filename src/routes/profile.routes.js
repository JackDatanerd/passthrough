const { Hono } = require('hono')
const auth = require('../middleware/auth')
const rl   = require('../middleware/rateLimiter')
const c    = require('../controllers/profile.controller')

const router = new Hono()

router.get(   '/',      auth, c.getProfile)
router.get(   '/data',  auth, c.getProfileData)          // the saved resume itself, for the editor
router.put(   '/',      auth, rl.profileEdit, c.updateProfile)           // correct the saved resume in place
router.get(   '/download-docx', auth, rl.profileDocx,   c.downloadProfileDocx)
router.get(   '/download-pdf',  auth, rl.profilePdf,    c.downloadProfilePdf)
router.post(  '/extras',          auth, rl.profileEdit, c.duplicatePrimary)
router.post(  '/extras/:id/make-main', auth, rl.profileEdit, c.promoteExtra)
router.get(   '/extras/:id/data', auth, c.getExtraData)
router.put(   '/extras/:id',      auth, rl.profileEdit, c.updateExtra)
router.delete('/extras/:id',      auth, c.deleteExtra)
router.patch( '/preferences', auth, c.updatePreferences)
router.post(  '/save',  auth, c.saveProfile)
router.post(  '/restore-previous', auth, rl.profileEdit, c.restorePreviousProfile)   // swap the main profile with the version it replaced
router.delete('/',      auth, c.deleteProfile)
// "Delete my scan history" — batched; the SPA loops until `remaining` is 0.
router.delete('/scans', auth, rl.historyPurge, c.deleteScanHistory)
// A full read of the account's scans and payments — rate-limited like the other
// heavy per-user reads.
router.get(   '/export', auth, rl.dataExport, c.exportMyData)

module.exports = router
