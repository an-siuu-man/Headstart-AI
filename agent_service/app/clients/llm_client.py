"""
Artifact: agent_service/app/clients/llm_client.py
Purpose: Wraps external LLM client construction for Nvidia-backed LangChain chat model calls.
Author: Ansuman Sharma
Created: 2026-02-27
Revised:
- 2026-02-27: Added dedicated client wrapper for ChatNVIDIA initialization. (Ansuman Sharma)
Preconditions:
- `langchain_nvidia_ai_endpoints` package is installed and credentials are configured externally.
Inputs:
- Acceptable: Model name string, numeric temperature, and max token values.
- Unacceptable: Unsupported model identifiers or non-numeric generation parameters.
Postconditions:
- Returns a configured ChatNVIDIA client instance for downstream orchestration.
Returns:
- `ChatNVIDIA` object.
Errors/Exceptions:
- Underlying provider/client initialization exceptions for invalid setup.
"""

import os

from langchain_nvidia_ai_endpoints import ChatNVIDIA
from langchain_nvidia_ai_endpoints._statics import MODEL_TABLE, Model, register_model

# Keep guide generation pinned to this exact model.
STRICT_GUIDE_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b"

# Always route through hosted NVIDIA NIM.
NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"
NVIDIA_CHAT_COMPLETIONS_ENDPOINT = f"{NVIDIA_NIM_BASE_URL}/chat/completions"


def _register_strict_guide_model_if_missing(model_name: str) -> None:
    """
    Ensure the strict guide model is known to the NVIDIA LangChain model table.

    This avoids the unknown-model path that queries /v1/models and can fail with
    duplicate candidates for the same model id.
    """
    if model_name != STRICT_GUIDE_MODEL_ID:
        return
    if model_name in MODEL_TABLE:
        return

    register_model(
        Model(
            id=STRICT_GUIDE_MODEL_ID,
            model_type="chat",
            client="ChatNVIDIA",
            endpoint=NVIDIA_CHAT_COMPLETIONS_ENDPOINT,
            supports_thinking=True,
            thinking_param_enable={"chat_template_kwargs": {"enable_thinking": True}},
            thinking_param_disable={"chat_template_kwargs": {"enable_thinking": False}},
        )
    )


def _is_duplicate_candidate_error(text: str) -> bool:
    lowered = text.lower()
    return "multiple candidates for" in lowered and "available_models" in lowered


def _is_model_listing_error(text: str) -> bool:
    lowered = text.lower()
    return (
        "/v1/models" in lowered
        or "failed to get models" in lowered
        or "no data found in response" in lowered
    )


def _is_auth_error(text: str) -> bool:
    lowered = text.lower()
    return any(
        token in lowered
        for token in (
            "unauthorized",
            "forbidden",
            "invalid api key",
            "authentication",
            "authorization",
            " 401",
            " 403",
        )
    )


def _strict_model_runtime_error(model_name: str, reason: str, raw_error: str) -> RuntimeError:
    return RuntimeError(
        "Failed to initialize strict guide model "
        f"'{model_name}' ({reason}). "
        "This service is configured to use this model only and will not fall back. "
        f"Original error: {raw_error}"
    )


def build_nvidia_chat_client(
    model_name: str,
    temperature: float,
    max_tokens: int,
    top_p: float,
    reasoning_budget: int = 16384,
    enable_thinking: bool = True,
) -> ChatNVIDIA:
    """Create a configured ChatNVIDIA client.

    For thinking/reasoning models (e.g. nemotron-super), `reasoning_budget` controls
    how many tokens the model may spend on internal reasoning, and
    `chat_template_kwargs={"enable_thinking": True}` activates that reasoning pass.
    Both must be set at construction time - they cannot be toggled per-request.
    """
    _register_strict_guide_model_if_missing(model_name)

    kwargs: dict = dict(
        model=model_name,
        base_url=NVIDIA_NIM_BASE_URL,
        api_key=os.environ["NVIDIA_API_KEY"],
        temperature=temperature,
        max_completion_tokens=max_tokens,
        top_p=top_p,
    )
    if enable_thinking:
        # NVIDIA reasoning controls are provider-specific; pass them through
        # model_kwargs to avoid LangChain "unknown parameter" warnings.
        kwargs["model_kwargs"] = {
            "reasoning_budget": reasoning_budget,
            "chat_template_kwargs": {"enable_thinking": True},
        }

    try:
        return ChatNVIDIA(**kwargs)
    except Exception as exc:
        message = str(exc)
        if _is_duplicate_candidate_error(message):
            raise _strict_model_runtime_error(model_name, "duplicate model candidates", message) from exc
        if _is_auth_error(message):
            raise _strict_model_runtime_error(model_name, "authentication/authorization error", message) from exc
        if _is_model_listing_error(message):
            raise _strict_model_runtime_error(model_name, "model listing error", message) from exc
        raise
