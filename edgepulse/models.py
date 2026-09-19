"""Wire contracts. Timestamps are Unix milliseconds, values use documented SI units."""
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Sample(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    device_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,48}$")
    boot_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    seq: int = Field(ge=0, le=2**53 - 1, strict=True)
    ts: int = Field(ge=0, le=2**53 - 1, strict=True)
    temperature: float = Field(ge=-100, le=300)
    vibration: float = Field(ge=0, le=1000)
    current: float = Field(ge=0, le=10000)

    @field_validator("ts")
    @classmethod
    def reject_future(cls, value):
        if value > int(time.time() * 1000) + 60_000:
            raise ValueError("timestamp more than 60 seconds in the future")
        return value


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    samples: list[Sample] = Field(min_length=1, max_length=500)


class DemoCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["start", "stop", "normal", "overheat", "vibration", "offline"]


RULES = {
    "temperature": {"high": 75.0, "low": 70.0, "unit": "°C", "label": "温度过高"},
    "vibration": {"high": 4.5, "low": 3.5, "unit": "mm/s", "label": "振动异常"},
    "current": {"high": 12.0, "low": 10.0, "unit": "A", "label": "电流过载"},
}
