"""
library.py — Official SKONGA Library access layer.

This module is the "official" programmatic entry point into the SKONGA
Library dataset (Subjects.json + Subjects/*.json + manifest.json). It is
built so that SKONGA AI — or any other assistant — can import it and treat
this folder as its authoritative curriculum source, without needing to know
anything about the on-disk file layout, filename quirks, or JSON structure.

Typical usage
-------------
    from library import SkongaLibrary

    lib = SkongaLibrary()                       # looks in the current folder
    lib.validate()                              # sanity-check the dataset
    subjects = lib.list_subjects()              # lightweight index
    bio = lib.get_subject("biology")            # full subject + forms + topics
    hits = lib.search("algebra")                # search subjects & topics
    context = lib.build_ai_context("mathematics")  # ready-to-paste LLM context

Command line usage
-------------------
    python3 library.py validate
    python3 library.py list
    python3 library.py show mathematics
    python3 library.py search "cell"
    python3 library.py context mathematics
    python3 library.py export library_export.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


class SkongaLibraryError(Exception):
    """Raised for problems reading or validating the SKONGA Library dataset."""


@dataclass
class Topic:
    subject_id: str
    subject_name: str
    form: str
    title: str


@dataclass
class Subject:
    id: str
    name: str
    icon: str
    forms: List[str]
    topics_count: int
    file: str
    notes_file: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def loaded(self) -> bool:
        return bool(self.data)

    def topics_by_form(self) -> Dict[str, List[str]]:
        return dict(self.data.get("forms", {}))

    def all_topics(self) -> List[Topic]:
        topics: List[Topic] = []
        for form_name, form_topics in self.topics_by_form().items():
            for title in form_topics:
                topics.append(Topic(self.id, self.name, form_name, title))
        return topics


class SkongaLibrary:
    """Official access layer for the SKONGA Library dataset.

    Any AI agent (SKONGA AI included) should treat an instance of this
    class as read access to the *entire* library: the subject index, every
    per-subject topic file, and the manifest describing how the data is
    organised. Nothing here mutates the dataset — it is a read-only,
    AI-facing interface.
    """

    INDEX_FILENAME = "Subjects.json"
    MANIFEST_FILENAME = "manifest.json"

    def __init__(self, base_path: str | Path = ".", strict: bool = False):
        self.base_path = Path(base_path).resolve()
        self.strict = strict
        self._manifest: Optional[Dict[str, Any]] = None
        self._subjects: Dict[str, Subject] = {}
        self._index_loaded = False

    # ------------------------------------------------------------------
    # Low-level loading
    # ------------------------------------------------------------------
    def _read_json(self, relative_path: str) -> Any:
        full_path = self.base_path / relative_path
        if not full_path.exists():
            raise SkongaLibraryError(f"Missing file: {relative_path}")
        try:
            with full_path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except json.JSONDecodeError as exc:
            raise SkongaLibraryError(
                f"Invalid JSON in {relative_path}: {exc.msg} (line {exc.lineno}, col {exc.colno})"
            ) from exc

    def load_manifest(self) -> Dict[str, Any]:
        """Load manifest.json (describes how this library wants to be consumed)."""
        if self._manifest is None:
            self._manifest = self._read_json(self.MANIFEST_FILENAME)
        return self._manifest

    def _load_index(self) -> None:
        if self._index_loaded:
            return
        raw = self._read_json(self.INDEX_FILENAME)
        if not isinstance(raw, list):
            raise SkongaLibraryError("Subjects.json must contain a JSON array of subjects.")
        for entry in raw:
            subject = Subject(
                id=entry["id"],
                name=entry["name"],
                icon=entry.get("icon", ""),
                forms=list(entry.get("forms", [])),
                topics_count=entry.get("topics", 0),
                file=entry["file"],
                notes_file=entry.get("notes_file"),
            )
            self._subjects[subject.id] = subject
        self._index_loaded = True

    def _ensure_loaded(self, subject: Subject) -> Subject:
        if not subject.loaded:
            subject.data = self._read_json(subject.file)
        return subject

    # ------------------------------------------------------------------
    # Public read API
    # ------------------------------------------------------------------
    def list_subjects(self) -> List[Subject]:
        """Return the lightweight subject index (no topic data loaded yet)."""
        self._load_index()
        return sorted(self._subjects.values(), key=lambda s: s.name)

    def get_subject(self, subject_id: str) -> Subject:
        """Return a subject with its full topic data loaded."""
        self._load_index()
        key = subject_id.strip().lower()
        subject = self._subjects.get(key)
        if subject is None:
            # allow lookup by name as a convenience
            for candidate in self._subjects.values():
                if candidate.name.lower() == key:
                    subject = candidate
                    break
        if subject is None:
            raise SkongaLibraryError(f"Unknown subject: {subject_id!r}")
        return self._ensure_loaded(subject)

    def get_all_subjects(self) -> List[Subject]:
        """Return every subject with topic data fully loaded (eager load)."""
        self._load_index()
        return [self._ensure_loaded(s) for s in self.list_subjects()]

    def get_notes(self, subject_id: str) -> Optional[str]:
        """Return the raw Markdown notes for a subject, or None if it doesn't have any yet."""
        subject = self.get_subject(subject_id)
        if not subject.notes_file:
            return None
        notes_path = self.base_path / subject.notes_file
        if not notes_path.exists():
            raise SkongaLibraryError(
                f"[{subject.id}] notes_file is set to '{subject.notes_file}' but that file does not exist on disk"
            )
        return notes_path.read_text(encoding="utf-8")

    def all_topics(self) -> List[Topic]:
        """Flatten the entire library into a single list of Topic records."""
        topics: List[Topic] = []
        for subject in self.get_all_subjects():
            topics.extend(subject.all_topics())
        return topics

    def search(self, query: str) -> Dict[str, List[Any]]:
        """Search subjects and topics by substring match (case-insensitive)."""
        q = query.strip().lower()
        if not q:
            return {"subjects": [], "topics": []}

        matched_subjects = [s for s in self.list_subjects() if q in s.name.lower()]
        matched_topics = [t for t in self.all_topics() if q in t.title.lower()]
        return {"subjects": matched_subjects, "topics": matched_topics}

    # ------------------------------------------------------------------
    # AI-facing helpers
    # ------------------------------------------------------------------
    def build_ai_context(self, subject_id: Optional[str] = None) -> str:
        """Build a plain-text context block ready to hand to an LLM.

        With no arguments, summarises every subject and its forms. Pass a
        subject_id to get a fully expanded, topic-by-topic breakdown for
        that single subject.
        """
        lines: List[str] = ["SKONGA LIBRARY — Tanzania secondary curriculum (Forms I-IV)", ""]

        if subject_id:
            subject = self.get_subject(subject_id)
            lines.append(f"Subject: {subject.name} {subject.icon}".strip())
            for form_name, topics in subject.topics_by_form().items():
                lines.append(f"\n{form_name}:")
                for title in topics:
                    lines.append(f"  - {title}")
        else:
            for subject in self.list_subjects():
                forms = ", ".join(subject.forms)
                lines.append(f"- {subject.name} {subject.icon} ({forms}) — {subject.topics_count} topics")

        return "\n".join(lines)

    def export_full_dataset(self) -> Dict[str, Any]:
        """Dump the entire library (manifest + every subject + topics) as one dict."""
        return {
            "manifest": self.load_manifest(),
            "subjects": [
                {
                    "id": s.id,
                    "name": s.name,
                    "icon": s.icon,
                    "forms": s.topics_by_form(),
                }
                for s in self.get_all_subjects()
            ],
        }

    # ------------------------------------------------------------------
    # Debugging / integrity check
    # ------------------------------------------------------------------
    def validate(self, verbose: bool = True) -> List[str]:
        """Check the dataset for structural problems.

        Verifies: manifest.json parses, Subjects.json parses, every
        referenced subject file exists and parses, every subject file
        actually contains a 'forms' object, declared topic counts match
        reality, AND — critically — that every *.json file physically
        sitting in Subjects/ is actually referenced by Subjects.json.
        That last check is the one that used to be missing: a subject
        file can be perfectly well-formed and still be completely
        invisible to SKONGA AI (and the website) if nothing points to
        it from the index, and the old version of this method had no
        way of catching that. Returns a list of problem descriptions
        (empty list means the library is healthy).
        """
        problems: List[str] = []

        try:
            self.load_manifest()
        except SkongaLibraryError as exc:
            problems.append(f"[manifest] {exc}")

        try:
            self._load_index()
        except SkongaLibraryError as exc:
            problems.append(f"[index] {exc}")
            if verbose:
                self._report(problems)
            return problems

        for subject in self.list_subjects():
            file_path = self.base_path / subject.file
            if not file_path.exists():
                problems.append(
                    f"[{subject.id}] file referenced in Subjects.json does not exist on disk: {subject.file}"
                )
                continue
            try:
                data = self._read_json(subject.file)
            except SkongaLibraryError as exc:
                problems.append(f"[{subject.id}] {exc}")
                continue
            if "forms" not in data or not isinstance(data["forms"], dict):
                problems.append(f"[{subject.id}] {subject.file} has no valid 'forms' object")
                continue
            missing_forms = set(subject.forms) - set(data["forms"].keys())
            if missing_forms:
                problems.append(
                    f"[{subject.id}] Subjects.json lists forms not present in {subject.file}: {sorted(missing_forms)}"
                )

            actual_topic_count = sum(len(topics) for topics in data["forms"].values())
            if actual_topic_count != subject.topics_count:
                problems.append(
                    f"[{subject.id}] Subjects.json says {subject.topics_count} topics, "
                    f"but {subject.file} actually has {actual_topic_count}"
                )

            if subject.notes_file:
                notes_path = self.base_path / subject.notes_file
                if not notes_path.exists():
                    problems.append(
                        f"[{subject.id}] notes_file '{subject.notes_file}' is declared but does not exist on disk"
                    )

        # ---- Reverse check: files on disk that Subjects.json never mentions ----
        # This is the check that was missing before — a subject can be
        # perfectly valid and STILL be invisible to SKONGA AI if nothing
        # in Subjects.json points to it.
        subjects_dir = self.base_path / "Subjects"
        if subjects_dir.is_dir():
            referenced_files = {Path(s.file).name for s in self.list_subjects()}
            actual_files = {p.name for p in subjects_dir.glob("*.json")}
            orphaned = actual_files - referenced_files
            for orphan in sorted(orphaned):
                problems.append(
                    f"[orphaned file] Subjects/{orphan} exists on disk but is NOT referenced in "
                    f"Subjects.json — SKONGA AI and the website will never see this subject."
                )

        if verbose:
            self._report(problems)
        return problems

    def _report(self, problems: List[str]) -> None:
        if not problems:
            print(f"✅ SKONGA Library at '{self.base_path}' is healthy — no problems found.")
            return
        print(f"⚠️  Found {len(problems)} problem(s) in '{self.base_path}':")
        for problem in problems:
            print(f"  - {problem}")


# ----------------------------------------------------------------------
# Command line interface
# ----------------------------------------------------------------------
def _main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="SKONGA Library — official access CLI")
    parser.add_argument("--path", default=".", help="Path to the library folder (default: current directory)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("validate", help="Check the dataset for structural problems")
    sub.add_parser("list", help="List all subjects")

    show_p = sub.add_parser("show", help="Show full topic breakdown for one subject")
    show_p.add_argument("subject_id")

    search_p = sub.add_parser("search", help="Search subjects and topics")
    search_p.add_argument("query")

    context_p = sub.add_parser("context", help="Build an AI-ready text context")
    context_p.add_argument("subject_id", nargs="?", default=None)

    notes_p = sub.add_parser("notes", help="Print the Markdown notes for a subject, if any exist")
    notes_p.add_argument("subject_id")

    export_p = sub.add_parser("export", help="Export the full dataset as one JSON file")
    export_p.add_argument("output_path")

    args = parser.parse_args(argv)
    lib = SkongaLibrary(args.path)

    try:
        if args.command == "validate":
            problems = lib.validate()
            return 1 if problems else 0

        if args.command == "list":
            for subject in lib.list_subjects():
                print(f"{subject.id:28s} {subject.icon}  {subject.name} ({subject.topics_count} topics)")

        elif args.command == "show":
            subject = lib.get_subject(args.subject_id)
            for form_name, topics in subject.topics_by_form().items():
                print(f"\n{form_name}")
                for title in topics:
                    print(f"  - {title}")

        elif args.command == "search":
            results = lib.search(args.query)
            print(f"Subjects matching '{args.query}':")
            for s in results["subjects"]:
                print(f"  - {s.name}")
            print(f"\nTopics matching '{args.query}':")
            for t in results["topics"]:
                print(f"  - {t.title}  ({t.subject_name}, {t.form})")

        elif args.command == "context":
            print(lib.build_ai_context(args.subject_id))

        elif args.command == "notes":
            notes = lib.get_notes(args.subject_id)
            print(notes if notes else f"No notes available yet for '{args.subject_id}'.")

        elif args.command == "export":
            data = lib.export_full_dataset()
            Path(args.output_path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"Exported full dataset to {args.output_path}")

    except SkongaLibraryError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
