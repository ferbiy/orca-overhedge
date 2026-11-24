This is the scheduled update run (@RUN_TS@) for the Overhedge fork of Orca, started headless by
run-update.sh on the server orca-ide. The fork (github.com/ferbiy/orca-overhedge) carries a small
patch on top of upstream Orca (stablyai/orca) releases: `overhedge/base-<id>` is the upstream tag,
`overhedge/patch-<id>` is the patch on it, and OVERHEDGE.md on the newest patch branch explains what
the patch does and how it was re-applied last time. The servers run the patched `orca-ide` .deb.

The source of truth for how an update is done is the runbook,
@HOME_DIR@/UPDATE-RUNBOOK.md (the same file as docs/overhedge/UPDATE-RUNBOOK.md on the fork's
overhedge/ci branch). It describes the steps, the checks and acceptance criteria, the stop
conditions, the hard rules, and the files a run leaves behind. The helper scripts it refers to live
in @HOME_DIR@/scripts/.

Context of this run:
- target release: @TAG@ (version @VERSION@, release id @RID@); latest-upstream.sh status: @STATUS@
- branch prefix: @PREFIX@ (`overhedge/rehearsal` means a rehearsal: scratch branches, nothing is
  deployed, and the rehearsal branches are deleted at the end as the runbook describes);
  rehearsal: @REHEARSAL@
- deploy policy configured: @POLICY@; this run's no-deploy flag: @NODEPLOY@. Deployment itself is
  never done in this session: run-update.sh and the deploy timer handle it after the result file says
  `ready`.
- result file this run is expected to write: @RESULT_FILE@ (format in the runbook, section
  "Result file")
- human-readable report: @REPORT_FILE@ (run-update.sh appends it to update-log.md and notifies the
  founder; the founder reads only that, so it should stand on its own)

Nobody watches this session and nobody can answer questions during it: where the runbook names a
stop condition, the run ends with RESULT=stopped and a report that explains the decision the founder
has to make.
