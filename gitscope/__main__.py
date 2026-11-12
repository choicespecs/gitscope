import argparse
import os

from .server import serve


def main():
    ap = argparse.ArgumentParser(prog="gitscope", description="Local git history visualizer")
    ap.add_argument("repo", nargs="?", help="path to a local git repository to open on start")
    ap.add_argument("-p", "--port", type=int, default=int(os.environ.get("GITSCOPE_PORT", 7777)))
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    a = ap.parse_args()
    serve(port=a.port, initial=a.repo, open_browser=not a.no_browser)


if __name__ == "__main__":
    main()
