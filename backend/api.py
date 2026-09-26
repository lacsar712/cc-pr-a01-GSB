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


SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS jobs (
        id serial PRIMARY KEY,
        sheet text NOT NULL,
        cyan_mm double precision NOT NULL,
        magenta_mm double precision NOT NULL,
        machine_name text NOT NULL DEFAULT '',
        status text NOT NULL,
        verdict text NOT NULL DEFAULT '',
        reason text NOT NULL DEFAULT '',
        created_by text NOT NULL,
        created_at timestamptz NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS machines (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        usable boolean NOT NULL DEFAULT TRUE,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
    )
    """,
    # 老库补列：机台称呼一旦写入任务即冻结，停用名册也改不掉旧任务上的称呼
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS machine_name text NOT NULL DEFAULT ''",
]


class LoginIn(BaseModel):
    username: str
    password: str


class MachineIn(BaseModel):
    name: str
    usable: bool = True


class MachineToggle(BaseModel):
    usable: bool


class JobIn(BaseModel):
    sheet: str
    cyan_mm: float
    magenta_mm: float
    machine_id: int | None = None


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
        raise HTTPException(status_code=403, detail="仅印刷员可执行此操作")
    return user


app = FastAPI(title="印刷套准复核台")


@app.on_event("startup")
def startup():
    with connect() as conn:
        for statement in SCHEMA_STATEMENTS:
            conn.execute(statement)
        n = conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]
        if n == 0:
            now = datetime.now(timezone.utc)
            conn.execute(
                """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, machine_name, status, verdict, reason, created_by, created_at)
                   VALUES
                   ('封面-01', 0.05, -0.04, '', 'pending', '', '', 'printer', %s),
                   ('内页-09', 0.40, 0.02, '', 'pending', '', '', 'printer', %s)""",
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
            "SELECT id, name, usable, created_by, created_at, updated_at FROM machines ORDER BY id"
        ).fetchall()


@app.post("/api/machines", status_code=201)
def register_machine(body: MachineIn, user: dict = Depends(require_writer)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="机台称呼不能为空")
    now = datetime.now(timezone.utc)
    with connect() as conn:
        try:
            row = conn.execute(
                """INSERT INTO machines (name, usable, created_by, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s)
                   RETURNING id, name, usable, created_by, created_at, updated_at""",
                (name, body.usable, user["username"], now, now),
            ).fetchone()
        except psycopg.errors.UniqueViolation as exc:
            raise HTTPException(status_code=409, detail=f"机台「{name}」已在名册中") from exc
        conn.commit()
    return row


@app.patch("/api/machines/{machine_id}")
def toggle_machine(machine_id: int, body: MachineToggle, _user: dict = Depends(require_writer)):
    with connect() as conn:
        row = conn.execute(
            """UPDATE machines SET usable = %s, updated_at = %s
               WHERE id = %s
               RETURNING id, name, usable, created_by, created_at, updated_at""",
            (body.usable, datetime.now(timezone.utc), machine_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="名册中没有这台机台")
        conn.commit()
    return row


@app.get("/api/jobs")
def list_jobs(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            "SELECT id, sheet, cyan_mm, magenta_mm, machine_name, status, verdict, reason, created_by FROM jobs ORDER BY id DESC"
        ).fetchall()


@app.post("/api/jobs", status_code=202)
def enqueue(body: JobIn, user: dict = Depends(require_writer)):
    with connect() as conn:
        machine = None
        if body.machine_id is not None:
            machine = conn.execute(
                "SELECT id, name, usable FROM machines WHERE id = %s", (body.machine_id,)
            ).fetchone()
        if machine is None:
            raise HTTPException(status_code=400, detail="缺机台：入队前必须挑选一台名册中仍可使用的机台，整笔退回")
        if not machine["usable"]:
            raise HTTPException(status_code=400, detail=f"机台已停：「{machine['name']}」已停用，整笔退回")
        row = conn.execute(
            """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, machine_name, status, created_by, created_at)
               VALUES (%s, %s, %s, %s, 'pending', %s, %s)
               RETURNING id, sheet, machine_name, status, verdict""",
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
