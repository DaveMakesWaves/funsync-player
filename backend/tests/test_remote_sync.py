"""Tests for the web-remote sync WebSockets.

FastAPI's `TestClient.websocket_connect` is sync-context; tests use that
pattern rather than httpx async.
"""

import json

import pytest
from fastapi.testclient import TestClient

from main import app
from routes.remote_sync import _reset_state_for_tests, _get_state_for_tests


@pytest.fixture(autouse=True)
def reset_remote_sync_state():
    """Each test gets a fresh session-scope singleton."""
    _reset_state_for_tests()
    yield
    _reset_state_for_tests()


@pytest.fixture
def client():
    # The websocket_connect context manager requires a TestClient, not AsyncClient.
    with TestClient(app) as c:
        yield c


# --- Phone endpoint ------------------------------------------------------

def test_phone_connect_sets_state(client):
    with client.websocket_connect("/api/remote/sync?videoId=abc123") as ws:
        state = _get_state_for_tests()
        assert state["has_phone"] is True
        assert state["phone_video_id"] == "abc123"


def test_phone_hello_updates_video_id(client):
    with client.websocket_connect("/api/remote/sync") as ws:
        ws.send_json({"type": "hello", "videoId": "from-hello-xyz"})
        # Small wait for the server to process
        # (TestClient runs the endpoint in the same process synchronously,
        #  so by the time send_json returns the server has received it
        #  and the next receive_* would block for a response — here we just
        #  check module state)
        import time
        time.sleep(0.05)
        state = _get_state_for_tests()
        assert state["phone_video_id"] == "from-hello-xyz"


def test_phone_malformed_json_does_not_crash(client):
    with client.websocket_connect("/api/remote/sync") as ws:
        ws.send_text("{not valid json")  # malformed
        ws.send_text("true")              # valid JSON but not a dict
        ws.send_json({"no_type_key": 1})  # dict without `type`
        # If we got here without exception the server tolerated all of it.
        ws.send_json({"type": "bye"})     # graceful close


def test_phone_bye_closes_cleanly(client):
    with client.websocket_connect("/api/remote/sync") as ws:
        ws.send_json({"type": "bye"})
    # After the `with` block the connection is closed; state should be cleared.
    import time
    time.sleep(0.05)
    state = _get_state_for_tests()
    assert state["has_phone"] is False


def test_phone_disconnect_clears_state(client):
    with client.websocket_connect("/api/remote/sync?videoId=xyz") as ws:
        state = _get_state_for_tests()
        assert state["has_phone"] is True
    import time
    time.sleep(0.05)
    state = _get_state_for_tests()
    assert state["has_phone"] is False
    assert state["phone_video_id"] is None


# --- Last-wins arbitration -----------------------------------------------

def test_second_phone_kicks_first(client):
    # Connect phone 1
    ws1 = client.websocket_connect("/api/remote/sync?videoId=first")
    conn1 = ws1.__enter__()
    # Connect phone 2 (should kick phone 1)
    with client.websocket_connect("/api/remote/sync?videoId=second") as conn2:
        # Phone 1 should receive a 'kicked' payload before the socket closes
        msg = conn1.receive_json()
        assert msg.get("type") == "kicked"
        assert "reason" in msg
        # State should now reflect phone 2
        import time
        time.sleep(0.05)
        state = _get_state_for_tests()
        assert state["phone_video_id"] == "second"
    # Clean up phone 1
    try:
        ws1.__exit__(None, None, None)
    except Exception:
        pass


# --- Observer endpoint ---------------------------------------------------

def test_observer_connect_sets_state(client):
    with client.websocket_connect("/api/remote/sync/observe") as obs:
        import time
        time.sleep(0.05)
        state = _get_state_for_tests()
        assert state["has_observer"] is True


def test_observer_receives_phone_connected(client):
    with client.websocket_connect("/api/remote/sync/observe") as obs:
        # Now connect a phone
        with client.websocket_connect("/api/remote/sync?videoId=x") as phone:
            msg = obs.receive_json()
            assert msg["type"] == "phone-connected"
            assert msg["videoId"] == "x"


def test_observer_receives_phone_state(client):
    with client.websocket_connect("/api/remote/sync/observe") as obs:
        with client.websocket_connect("/api/remote/sync?videoId=x") as phone:
            _ = obs.receive_json()  # consume phone-connected
            phone.send_json({"type": "state", "at": 1234, "paused": False})
            msg = obs.receive_json()
            assert msg["type"] == "state"
            assert msg["at"] == 1234
            assert msg["paused"] is False
            assert msg["from"] == "phone"


def test_observer_receives_phone_disconnected(client):
    with client.websocket_connect("/api/remote/sync/observe") as obs:
        with client.websocket_connect("/api/remote/sync?videoId=x") as phone:
            _ = obs.receive_json()  # phone-connected
        # phone disconnected — observer should see the event
        msg = obs.receive_json()
        assert msg["type"] == "phone-disconnected"


def test_observer_catch_up_with_existing_phone(client):
    """An observer that connects AFTER the phone should immediately receive
    the current phone-connected + last-state snapshot."""
    with client.websocket_connect("/api/remote/sync?videoId=late") as phone:
        phone.send_json({"type": "state", "at": 500, "paused": False})
        import time
        time.sleep(0.05)
        with client.websocket_connect("/api/remote/sync/observe") as obs:
            first = obs.receive_json()
            assert first["type"] == "phone-connected"
            assert first["videoId"] == "late"
            second = obs.receive_json()
            assert second["type"] == "state"
            assert second["at"] == 500


def test_observer_sees_replacement_event(client):
    ws1 = client.websocket_connect("/api/remote/sync?videoId=first")
    conn1 = ws1.__enter__()
    try:
        with client.websocket_connect("/api/remote/sync/observe") as obs:
            # Consume the initial phone-connected snapshot
            _ = obs.receive_json()
            with client.websocket_connect("/api/remote/sync?videoId=second") as _new:
                # Observer should see phone-replaced OR a new phone-connected
                seen_replaced = False
                for _ in range(3):
                    msg = obs.receive_json()
                    if msg.get("type") == "phone-replaced":
                        seen_replaced = True
                        assert msg["newIp"] is not None
                        break
                assert seen_replaced, "Observer never received phone-replaced event"
    finally:
        try:
            ws1.__exit__(None, None, None)
        except Exception:
            pass


def test_observer_forwards_to_phone(client):
    """Observer sends a payload (e.g. device-status) — the phone receives it."""
    with client.websocket_connect("/api/remote/sync?videoId=x") as phone:
        with client.websocket_connect("/api/remote/sync/observe") as obs:
            # Consume the catch-up payload
            _ = obs.receive_json()
            obs.send_json({
                "type": "device-status",
                "handy": "connected",
                "buttplug": "disconnected",
            })
            msg = phone.receive_json()
            assert msg["type"] == "device-status"
            assert msg["handy"] == "connected"


def test_observer_malformed_json_does_not_crash(client):
    with client.websocket_connect("/api/remote/sync/observe") as obs:
        obs.send_text("{not valid")
        obs.send_text("42")
        obs.send_json({"no_type_key": True})
        # Still alive — send a real payload to confirm
        obs.send_json({"type": "device-status", "handy": "connected"})


def test_second_observer_replaces_first(client):
    ws1 = client.websocket_connect("/api/remote/sync/observe")
    obs1 = ws1.__enter__()
    try:
        with client.websocket_connect("/api/remote/sync/observe") as obs2:
            # obs1 should be kicked; obs2 is now the observer
            import time
            time.sleep(0.05)
            state = _get_state_for_tests()
            assert state["has_observer"] is True
    finally:
        try:
            ws1.__exit__(None, None, None)
        except Exception:
            pass


def test_cycle_phone_observer_phone(client):
    """Integration: full connect/disconnect cycle doesn't leak state."""
    with client.websocket_connect("/api/remote/sync?videoId=a") as phone1:
        phone1.send_json({"type": "state", "at": 1, "paused": False})
    # Now connect observer; should see no active phone
    with client.websocket_connect("/api/remote/sync/observe") as obs:
        import time
        time.sleep(0.05)
        state = _get_state_for_tests()
        assert state["has_phone"] is False
        # Now a new phone connects
        with client.websocket_connect("/api/remote/sync?videoId=b") as phone2:
            msg = obs.receive_json()
            assert msg["type"] == "phone-connected"
            assert msg["videoId"] == "b"
