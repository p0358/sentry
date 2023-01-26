import logging

from sentry.lang.javascript.symbolicator import Symbolicator
from sentry.lang.native.error import SymbolicationFailed, write_error
from sentry.models import EventError, Project
from sentry.stacktraces.processing import find_stacktraces_in_data
from sentry.utils.safe import get_path

logger = logging.getLogger(__name__)


def _merge_frame(new_frame, symbolicated):
    new_frame = dict(new_frame)
    symbolicated = dict(symbolicated)

    if symbolicated.get("function"):
        new_frame["function"] = symbolicated["function"]
    if symbolicated.get("abs_path"):
        new_frame["abs_path"] = symbolicated["abs_path"]
    if symbolicated.get("filename"):
        new_frame["filename"] = symbolicated["filename"]
    if symbolicated.get("lineno"):
        new_frame["lineno"] = symbolicated["lineno"]
    if symbolicated.get("colno"):
        new_frame["colno"] = symbolicated["colno"]
    if symbolicated.get("pre_context"):
        new_frame["pre_context"] = symbolicated["pre_context"]
    if symbolicated.get("context_line"):
        new_frame["context_line"] = symbolicated["context_line"]
    if symbolicated.get("post_context"):
        new_frame["post_context"] = symbolicated["post_context"]
    if symbolicated.get("status"):
        frame_meta = new_frame.setdefault("data", {})
        frame_meta["symbolicator_status"] = symbolicated["status"]

    return new_frame


# TODO: Change this error handling to be JS-specific?
def _handle_response_status(event_data, response_json):
    if not response_json:
        error = SymbolicationFailed(type=EventError.NATIVE_INTERNAL_FAILURE)
    elif response_json["status"] == "completed":
        return True
    elif response_json["status"] == "failed":
        error = SymbolicationFailed(
            message=response_json.get("message") or None, type=EventError.NATIVE_SYMBOLICATOR_FAILED
        )
    else:
        logger.error("Unexpected symbolicator status: %s", response_json["status"])
        error = SymbolicationFailed(type=EventError.NATIVE_INTERNAL_FAILURE)

    write_error(error, event_data)


def _handles_frame(data, frame):
    if not frame:
        return False

    # TODO: Filter frames on something else than just "abs_path"
    if get_path(frame, "abs_path") is None:
        return False

    platform = frame.get("platform") or data.get("platform")
    return platform in ("javascript", "node")


def get_frames_for_symbolication(frames, data):
    rv = []

    for frame in reversed(frames):
        if not _handles_frame(data, frame):
            continue
        rv.append(dict(frame))

    return rv


def process_payload(data):
    # We cannot symbolicate JS stacktraces without a release.
    if data.get("release") is None:
        return

    project = Project.objects.get_from_cache(id=data["project"])

    symbolicator = Symbolicator(project=project, release=data["release"], event_id=data["event_id"])

    stacktrace_infos = [stacktrace for stacktrace in find_stacktraces_in_data(data)]
    stacktraces = [
        {
            "frames": get_frames_for_symbolication(sinfo.stacktrace.get("frames") or (), data),
        }
        for sinfo in stacktrace_infos
    ]

    if not any(stacktrace["frames"] for stacktrace in stacktraces):
        return

    response = symbolicator.process_payload(stacktraces=stacktraces, dist=data.get("dist"))

    if not _handle_response_status(data, response):
        return data

    assert len(stacktraces) == len(response["stacktraces"]), (stacktraces, response)

    for sinfo, complete_stacktrace in zip(stacktrace_infos, response["stacktraces"]):
        new_frames = []

        for raw_frame, complete_frame in zip(
            sinfo.stacktrace["frames"], complete_stacktrace["frames"]
        ):
            merged_frame = _merge_frame(raw_frame, complete_frame)
            new_frames.append(merged_frame)

        if sinfo.container is not None:
            sinfo.container["raw_stacktrace"] = {
                "frames": list(sinfo.stacktrace["frames"]),
            }

        sinfo.stacktrace["frames"] = new_frames

    return data


def get_symbolication_function(data):
    return process_payload
