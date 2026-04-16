"""Network utilities — local IP detection for script hosting."""

import socket


def get_local_ip() -> str:
    """Detect the local network IP address for script hosting.

    Returns:
        Local IP address string (e.g. '192.168.1.100').
        Falls back to '127.0.0.1' if detection fails.
    """
    try:
        # Create a socket to determine the outbound IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        # Doesn't actually send data — just determines the local IP
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"
