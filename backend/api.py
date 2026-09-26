import os
from datetime import datetime, timedelta, timezone

import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from psycopg.rows import dict_row

DSN = os.environ.get("DATABASE_URL", "postgresql://app:app@localhost:54394/printreg")
SECRET = os.environ.get("JWT_SECRET", "print-register-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
USERS = {
    "printer": {"role": "writer", "password_hash": pwd.hash("print123456")},
    "checker": {"role": "reader", "password_hash": pwd.hash("check123456")},
}


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


SCHEMA = """
CREATE TABLE IF NOT EXISTS machines (
    id serial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    active boolean NOT NULL DEFAULT true,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL,
    deactivated_at timestamptz
);

CREATE TABLE IF NOT EXISTS jobs (
    id serial PRIMARY KEY,
    sheet text NOT NULL,
    cyan_mm double precision NOT NULL,
    magenta_mm double precision NOT NULL,
    status text NOT NULL,
    verdict text NOT NULL DEFAULT '',
    reason text NOT NULL DEFAULT '',
    machine_name text NOT NULL DEFAULT '',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL
);

-- 兼容旧库：baseline 的 jobs 表没有 machine_name 列
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS machine_name text NOT NULL DEFAULT '';
"""


class LoginIn(BaseModel):
    username: str
    password: str


class JobIn(BaseModel):
    sheet: str
    cyan_mm: float
    magenta_mm: float
    machine_id: int | None = None


class MachineIn(BaseModel):
    name: str


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(credentials.credentials, SECRET, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="无效令牌") from exc
    if payload.get("sub") not in USERS:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"username": payload["sub"], "role": payload.get("role")}


def require_writer(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "writer":
        raise HTTPException(status_code=403, detail="仅印刷员可登记机台或送复核")
    return user


app = FastAPI(title="印刷套准复核台")


@app.on_event("startup")
def startup():
    with connect() as conn:
        conn.execute(SCHEMA)
        n = conn.execute("SELECT COUNT(*) AS n FROM machines").fetchone()["n"]
        if n == 0:
            now = datetime.now(timezone.utc)
            conn.execute(
                """INSERT INTO machines (name, active, created_by, created_at)
                   VALUES ('一号机', true, 'printer', %s)""",
                (now,),
            )
        n = conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]
        if n == 0:
            now = datetime.now(timezone.utc)
            conn.execute(
                """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, status, verdict, reason, machine_name, created_by, created_at)
                   VALUES
                   ('封面-01', 0.05, -0.04, 'pending', '', '', '一号机', 'printer', %s),
                   ('内页-09', 0.40, 0.02, 'pending', '', '', '一号机', 'printer', %s)""",
                (now, now),
            )
        conn.commit()


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "print-register-review"}


@app.post("/api/auth/login")
def login(body: LoginIn):
    user = USERS.get(body.username.strip())
    if not user or not pwd.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode({"sub": body.username.strip(), "role": user["role"], "exp": exp}, SECRET, algorithm="HS256")
    return {"access_token": token, "username": body.username.strip(), "role": user["role"]}


@app.get("/api/machines")
def list_machines(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            """SELECT id, name, active, created_by, created_at, deactivated_at
               FROM machines ORDER BY active DESC, id ASC"""
        ).fetchall()


@app.post("/api/machines", status_code=201)
def register_machine(body: MachineIn, user: dict = Depends(require_writer)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="机台称呼不能为空")
    with connect() as conn:
        try:
            row = conn.execute(
                """INSERT INTO machines (name, active, created_by, created_at)
                   VALUES (%s, true, %s, %s)
                   RETURNING id, name, active, created_by, created_at, deactivated_at""",
                (name, user["username"], datetime.now(timezone.utc)),
            ).fetchone()
        except psycopg.errors.UniqueViolation:
            raise HTTPException(status_code=409, detail="机台称呼已存在") from None
        conn.commit()
    return row


@app.post("/api/machines/{machine_id}/stop", status_code=200)
def stop_machine(machine_id: int, user: dict = Depends(require_writer)):
    with connect() as conn:
        row = conn.execute(
            """UPDATE machines
               SET active = false, deactivated_at = %s
               WHERE id = %s AND active = true
               RETURNING id, name, active, created_by, created_at, deactivated_at""",
            (datetime.now(timezone.utc), machine_id),
        ).fetchone()
        if row is None:
            exists = conn.execute("SELECT 1 FROM machines WHERE id = %s", (machine_id,)).fetchone()
            if exists is None:
                raise HTTPException(status_code=404, detail="机台不存在")
            raise HTTPException(status_code=409, detail="机台已停")
        conn.commit()
    return row


@app.get("/api/jobs")
def list_jobs(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            """SELECT j.id, j.sheet, j.cyan_mm, j.magenta_mm, j.status, j.verdict, j.reason,
                      j.machine_name, j.created_by,
                      m.id AS machine_id, m.active AS machine_active
               FROM jobs j
               LEFT JOIN machines m ON m.name = j.machine_name
               ORDER BY j.id DESC"""
        ).fetchall()


@app.post("/api/jobs", status_code=202)
def enqueue(body: JobIn, user: dict = Depends(require_writer)):
    if body.machine_id is None:
        raise HTTPException(status_code=400, detail="缺机台：送复核前必须挑选一台仍可使用的机台")
    with connect() as conn:
        # 锁住机台行，避免登记与停用并发时挑到刚停的机台
        machine = conn.execute(
            "SELECT id, name, active FROM machines WHERE id = %s FOR UPDATE",
            (body.machine_id,),
        ).fetchone()
        if machine is None:
            raise HTTPException(status_code=400, detail="缺机台：机台名册里没有这台机台")
        if not machine["active"]:
            raise HTTPException(status_code=409, detail="机台已停：该机台已停用，请改选可使用的机台")
        row = conn.execute(
            """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, status, machine_name, created_by, created_at)
               VALUES (%s, %s, %s, 'pending', %s, %s, %s)
               RETURNING id, sheet, status, verdict, machine_name""",
            (
                body.sheet.strip(),
                body.cyan_mm,
                body.magenta_mm,
                machine["name"],
                user["username"],
                datetime.now(timezone.utc),
            ),
        ).fetchone()
        conn.commit()
    return row
