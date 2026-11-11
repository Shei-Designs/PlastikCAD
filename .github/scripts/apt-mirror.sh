#!/usr/bin/env bash
# Run before a job installs system packages: makes sure the runner can fetch them.
#
# The runners fetch packages from Ubuntu's own hosts, through the list in /etc/apt/apt-mirrors.txt.
# On 2026-11-11 those names could not be resolved from the runners for hours: every Linux job failed
# before a single test ran, and the Linux packages of a release were not built. When the list as it
# stands does not answer, it is replaced by mirrors of the same archive on other domains.
set -u

# A failed index counts as a failure (apt otherwise carries on with the old ones), and nothing waits long.
refresh() {
  sudo timeout 240 apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=1 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update
}

if refresh; then
  exit 0
fi

echo "::warning::The runner's package mirrors did not answer; using mirrors on other domains."
if [ -f /etc/apt/apt-mirrors.txt ]; then
  printf '%s\n' \
    'https://mirrors.edge.kernel.org/ubuntu/	priority:1' \
    'https://mirror.leaseweb.com/ubuntu/	priority:2' \
    'https://ftp.halifax.rwth-aachen.de/ubuntu/	priority:3' | sudo tee /etc/apt/apt-mirrors.txt
else
  # An image that names its hosts in the sources themselves.
  sudo sed -i -E 's#https?://(azure\.archive|archive|security)\.ubuntu\.com/ubuntu/?#https://mirrors.edge.kernel.org/ubuntu/#g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null
fi
refresh
