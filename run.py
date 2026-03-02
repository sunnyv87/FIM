#!/usr/bin/env python3
"""
FIM Dashboard launcher.
Usage: python run.py [--host HOST] [--port PORT]
"""
import argparse
import os

import eventlet
eventlet.monkey_patch()

from fim_engine import init_db
from app import app, socketio, monitor

def main():
    parser = argparse.ArgumentParser(description="File Integrity Monitoring Dashboard")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=5000, help="Port to listen on (default: 5000)")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    args = parser.parse_args()

    init_db()

    # Auto-start monitor if paths are already configured
    from fim_engine import get_monitored_paths
    if get_monitored_paths():
        monitor.start()
        print("[FIM] Monitor started for existing watch paths.")

    print(f"\n  File Integrity Monitor")
    print(f"  Dashboard → http://{args.host}:{args.port}")
    print(f"  Press Ctrl+C to stop.\n")

    socketio.run(app, host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
