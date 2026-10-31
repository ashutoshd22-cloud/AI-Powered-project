"""Admin commands: `vapid` prints a Web Push key pair, `fernet` an encryption key for .env."""

import sys

from app.services.push import generate_keys


def main(argv: list[str]) -> int:
    if argv[:1] == ["vapid"]:
        private, public = generate_keys()
        print("# Add to .env (keep the private key secret):")
        print(f"VAPID_PRIVATE_KEY={private}")
        print("VAPID_SUBJECT=mailto:you@example.com")
        print(f"# Public key (served automatically to browsers): {public}")
        return 0
    if argv[:1] == ["fernet"]:
        from app.services.google_calendar import new_key

        print("# Add to .env (keep it secret; changing it disconnects Google Calendar):")
        print(f"TOKEN_ENCRYPTION_KEY={new_key()}")
        return 0
    print("usage: python -m app.cli vapid | fernet", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
