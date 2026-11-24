FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq systemd systemd-sysv dbus sudo pigz jq curl procps psmisc ca-certificates git iproute2 >/dev/null \
 && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu && chmod 440 /etc/sudoers.d/ubuntu \
 && systemctl mask getty@tty1.service console-getty.service systemd-logind.service >/dev/null 2>&1 || true
COPY orca-serve.service /etc/systemd/system/orca-serve.service
COPY keep-sessions.conf /etc/systemd/system/orca-serve.service.d/keep-sessions.conf
RUN systemctl enable orca-serve.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
