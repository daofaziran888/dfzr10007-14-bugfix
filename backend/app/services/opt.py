"""查询优化建议业务规则：状态流转、字段校验、并发采纳与审计轨迹都收在这里。

状态只能沿 待采纳 -> 已采纳 -> 已执行 -> 已关闭 单向推进：
- 跳级、倒序或重复动作一律拒绝，原记录保持不变；
- 每次合法流转都会在 entry["状态轨迹"] 追加一条审计记录，已执行不可能回到待采纳；
- 同一目标查询同时只允许一个生效版本，并发采纳时只有一个请求能成功。
"""
from __future__ import annotations

import threading
from datetime import date
from typing import Any

from app.store import store

MODULE = "opt"
# 登记时必须完整落库的字段；缺任一字段都不能返回成功。
REQUIRED_FIELDS = ["建议编号", "目标查询", "优化类型", "当前耗时", "预计提速", "优化方案"]
# 登记时允许一并保存的可选字段。
OPTIONAL_FIELDS = ["建议时间"]
STATUS_ORDER = ["待采纳", "已采纳", "已执行", "已关闭"]
# 动作 -> (允许的当前状态, 流转后的目标状态)，目标状态必须正好是当前状态的下一格。
ACTION_RULES: dict[str, tuple[str, str]] = {
    "采纳建议": ("待采纳", "已采纳"),
    "标记执行": ("已采纳", "已执行"),
    "关闭建议": ("已执行", "已关闭"),
}
# 视为“生效中”的状态：同一目标查询在这些状态下不允许再采纳第二个版本。
ACTIVE_STATUSES = ("已采纳", "已执行", "已关闭")


class OptService:
    """所有写操作都在同一把模块锁内完成，保证并发采纳/重复动作只有一个结果落库。"""

    _lock = threading.RLock()

    def list_entries(
        self,
        *,
        keyword: str | None = None,
        status: str | None = None,
        page: int = 1,
        size: int = 20,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = store.rows(MODULE)
        if keyword:
            rows = [
                row
                for row in rows
                if keyword in str(row.get("建议编号", ""))
                or keyword in str(row.get("目标查询", ""))
            ]
        if status:
            rows = [row for row in rows if row.get("status") == status]
        total = len(rows)
        start = max(page - 1, 0) * size
        return rows[start:start + size], total

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        return store.find(MODULE, entry_id)

    @staticmethod
    def _text(values: dict[str, Any], field: str) -> str:
        value = values.get(field)
        return str(value).strip() if value is not None else ""

    def create_entry(
        self, values: dict[str, Any]
    ) -> tuple[dict[str, Any] | None, str]:
        """登记一条优化建议。

        返回 (entry, message)：entry 为 None 表示登记被拒绝（message 说明原因），
        此时不会写入任何数据；字段没有完整落库时绝不返回成功。
        """
        missing = [field for field in REQUIRED_FIELDS if not self._text(values, field)]
        if missing:
            return None, f"缺少必填字段：{'、'.join(missing)}"
        with self._lock:
            rows = store.rows(MODULE)
            code = self._text(values, "建议编号")
            if any(str(row.get("建议编号", "")) == code for row in rows):
                return None, f"建议编号 {code} 已存在，重复登记不会产生新记录"
            entry: dict[str, Any] = {
                "id": max((int(row.get("id", 0)) for row in rows), default=0) + 1
            }
            for field in REQUIRED_FIELDS:
                entry[field] = self._text(values, field)
            for field in OPTIONAL_FIELDS:
                text = self._text(values, field)
                if text:
                    entry[field] = text
            entry.setdefault("建议时间", date.today().isoformat())
            entry["status"] = STATUS_ORDER[0]
            # 执行状态列与内部状态始终保持同一份口径，避免列表出现状态残留。
            entry["执行状态"] = entry["status"]
            entry["pending"] = True
            entry["abnormal"] = False
            entry["状态轨迹"] = [
                {
                    "动作": "登记建议",
                    "原状态": None,
                    "新状态": entry["status"],
                    "说明": "优化建议登记入库",
                    "时间": entry["建议时间"],
                }
            ]
            rows.append(entry)
            return entry, "优化建议已登记"

    def run_action(self, entry_id: int, action: str) -> tuple[dict[str, Any] | None, str]:
        """对单条建议执行动作；非法动作返回 (None, 原因)，原记录保持不变。"""
        action = (action or "").strip()
        with self._lock:
            entry = store.find(MODULE, entry_id)
            if entry is None:
                return None, f"优化建议 {entry_id} 不存在或已归档"
            if action not in ACTION_RULES:
                return None, f"动作「{action}」不属于查询优化建议可执行范围"

            expected_status, target_status = ACTION_RULES[action]
            current_status = str(entry.get("status", ""))
            current_index = STATUS_ORDER.index(current_status) if current_status in STATUS_ORDER else -1
            target_index = STATUS_ORDER.index(target_status)

            # 单向推进：目标状态必须正好是当前状态的下一格，跳级/倒序/重复都拒绝。
            if current_index < 0 or target_index != current_index + 1:
                return (
                    None,
                    f"当前状态为「{current_status}」，不能执行「{action}」"
                    f"（仅允许从「{expected_status}」执行该动作，状态只能单向推进）",
                )

            # 并发采纳同一目标查询：已存在生效版本时，第二个版本不允许生效。
            if action == "采纳建议":
                target_query = str(entry.get("目标查询", ""))
                conflict = next(
                    (
                        row
                        for row in store.rows(MODULE)
                        if int(row.get("id", 0)) != entry_id
                        and str(row.get("目标查询", "")) == target_query
                        and row.get("status") in ACTIVE_STATUSES
                    ),
                    None,
                )
                if conflict is not None:
                    return (
                        None,
                        f"目标查询已有生效版本 {conflict.get('建议编号')}"
                        f"（状态：{conflict.get('status')}），同一查询只能一个版本生效",
                    )

            trail = entry.setdefault("状态轨迹", [])
            trail.append(
                {
                    "动作": action,
                    "原状态": current_status,
                    "新状态": target_status,
                    "说明": f"{current_status} -> {target_status}",
                    "时间": date.today().isoformat(),
                }
            )
            entry["status"] = target_status
            entry["执行状态"] = target_status
            entry["pending"] = target_status != STATUS_ORDER[-1]
            entry["abnormal"] = False
            return entry, f"优化建议已{action}，状态：{current_status} -> {target_status}"
