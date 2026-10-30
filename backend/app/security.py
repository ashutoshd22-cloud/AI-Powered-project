"""Password hashing, session tokens and CSRF helpers."""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.models import utcnow

_hasher = PasswordHasher()  # Argon2id with library defaults (RFC 9106 low-memory profile)

# Pre-computed hash used to equalise timing when the e-mail address does not exist.
_DUMMY_HASH = _hasher.hash("lifeos-timing-equaliser")

SESSION_COOKIE = "lifeos_session"
CSRF_COOKIE = "lifeos_csrf"
CSRF_HEADER = "X-CSRF-Token"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_match(token: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_token(token), expected_hash)


def session_expiry(days: int) -> datetime:
    return utcnow() + timedelta(days=days)
