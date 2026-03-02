"""
FIM Web Application
Flask + Flask-SocketIO backend serving the real-time dashboard.
"""

import os
import threading

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit

from fim_engine import (
    init_db,
    build_baseline,
    get_baseline,
    get_events,
    get_event_stats,
    get_monitored_paths,
    add_monitored_path,
    remove_monitored_path,
    log_event,
    FIMMonitor,
)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "fim-secret-key-change-in-prod")
CORS(app)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

# Global monitor instance
_monitor_lock = threading.Lock()
monitor = FIMMonitor(event_callback=lambda ev: socketio.emit("fim_event", ev))


# ---------------------------------------------------------------------------
# REST API — Stats & Events
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/stats")
def api_stats():
    return jsonify(get_event_stats())


@app.route("/api/events")
def api_events():
    limit  = int(request.args.get("limit", 200))
    offset = int(request.args.get("offset", 0))
    return jsonify(get_events(limit=limit, offset=offset))


@app.route("/api/baseline")
def api_baseline():
    baseline = get_baseline()
    files = list(baseline.values())
    files.sort(key=lambda x: x["path"])
    return jsonify(files)


# ---------------------------------------------------------------------------
# REST API — Monitored Paths
# ---------------------------------------------------------------------------

@app.route("/api/paths", methods=["GET"])
def api_get_paths():
    return jsonify(get_monitored_paths())


@app.route("/api/paths", methods=["POST"])
def api_add_path():
    data = request.get_json(force=True)
    path = data.get("path", "").strip()
    recursive = bool(data.get("recursive", True))

    if not path:
        return jsonify({"error": "path is required"}), 400
    if not os.path.exists(path):
        return jsonify({"error": f"path does not exist: {path}"}), 400

    record = add_monitored_path(path, recursive)

    # Build/update baseline for the new path
    threading.Thread(
        target=build_baseline, args=(path,), kwargs={"recursive": recursive}, daemon=True
    ).start()

    # Restart monitor to pick up the new path
    with _monitor_lock:
        monitor.restart()

    socketio.emit("paths_updated", get_monitored_paths())
    return jsonify(record), 201


@app.route("/api/paths", methods=["DELETE"])
def api_remove_path():
    data = request.get_json(force=True)
    path = data.get("path", "").strip()
    if not path:
        return jsonify({"error": "path is required"}), 400

    remove_monitored_path(path)

    with _monitor_lock:
        monitor.restart()

    socketio.emit("paths_updated", get_monitored_paths())
    return jsonify({"removed": path})


# ---------------------------------------------------------------------------
# REST API — Monitor control
# ---------------------------------------------------------------------------

@app.route("/api/monitor/start", methods=["POST"])
def api_start():
    with _monitor_lock:
        monitor.start()
    socketio.emit("monitor_status", {"running": monitor.running})
    return jsonify({"running": monitor.running})


@app.route("/api/monitor/stop", methods=["POST"])
def api_stop():
    with _monitor_lock:
        monitor.stop()
    socketio.emit("monitor_status", {"running": monitor.running})
    return jsonify({"running": monitor.running})


@app.route("/api/monitor/status")
def api_status():
    return jsonify({"running": monitor.running})


@app.route("/api/monitor/rescan", methods=["POST"])
def api_rescan():
    """Rebuild baseline for all active monitored paths."""
    def _rescan():
        for p in get_monitored_paths():
            build_baseline(p["path"], recursive=bool(p["recursive"]))
        socketio.emit("rescan_complete", get_event_stats())

    threading.Thread(target=_rescan, daemon=True).start()
    return jsonify({"status": "rescan started"})


# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    emit("monitor_status", {"running": monitor.running})
    emit("stats_update", get_event_stats())


@socketio.on("request_stats")
def on_request_stats():
    emit("stats_update", get_event_stats())


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)
