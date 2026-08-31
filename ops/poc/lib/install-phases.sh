#!/bin/sh

run_installation_phases() {
  validate_core_assets
  activate_core_assets
  enable_core_timers

  set +e
  (
    set -e
    prepare_observability_assets
    pull_observability_images
    validate_observability_assets
    activate_observability_assets
    start_observability_services
  )
  observability_status=$?
  set -e

  if [ "$observability_status" -ne 0 ]; then
    printf '%s\n' \
      'Dialed observability installation failed; core deploy and backup timers remain enabled.' \
      'The Dialed POC application stack was left unchanged.' >&2
    return "$observability_status"
  fi
}
