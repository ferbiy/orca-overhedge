# deploy.sh tests (disposable systemd container)

Run on orca-ide from a copy of this folder (needs Docker and the debs in ~/overhedge-build/artifacts):
`run-test.sh` (check-only idle/busy, refusal while busy, dry-run, real deploy official -> overhedge,
rollback of a deliberately broken build through deploy-pending.sh, night-window and deferral logic,
cleanup dry-run) and `run-test-terminal.sh` (a live terminal survives a deploy and is counted).
The container runs systemd (`--privileged --cgroupns=private`), a copy of orca-serve.service with
`--no-pairing`, and never touches the host's service. busy-cli.sh fakes a working chat in `agent list`.
