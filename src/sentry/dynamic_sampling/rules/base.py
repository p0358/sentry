from typing import List, OrderedDict, Set

import sentry_sdk

from sentry import quotas
from sentry.dynamic_sampling.rules.biases.base import Bias, BiasParams
from sentry.dynamic_sampling.rules.combine import (
    get_relay_biases_combinator,
    get_relay_biases_combinator_v2,
)
from sentry.dynamic_sampling.rules.logging import log_rules
from sentry.dynamic_sampling.rules.utils import PolymorphicRule, RuleType, get_enabled_user_biases
from sentry.models import Project

ALWAYS_ALLOWED_RULE_TYPES = {RuleType.UNIFORM_RULE}


def get_guarded_blended_sample_rate(project: Project) -> float:
    sample_rate = quotas.get_blended_sample_rate(project)

    if sample_rate is None:
        raise Exception("get_blended_sample_rate returns none")

    return float(sample_rate)


def _get_rules_of_enabled_biases(
    project: Project,
    base_sample_rate: float,
    enabled_biases: Set[str],
    combined_biases: OrderedDict[RuleType, Bias],
    version_2: bool = False,
) -> List[PolymorphicRule]:
    rules = []

    for (rule_type, bias) in combined_biases.items():
        # All biases besides the uniform won't be enabled in case we have 100% base sample rate. This has been
        # done because if we don't have a sample rate < 100%, it doesn't make sense to enable dynamic sampling in
        # the first place. Technically dynamic sampling it is still enabled but for our customers this detail is
        # not important.
        if rule_type in ALWAYS_ALLOWED_RULE_TYPES or (
            rule_type.value in enabled_biases and base_sample_rate < 1.0
        ):
            rules += bias.get_rules(BiasParams(project, base_sample_rate))

    # We want to log only rules v2, to avoid confusion and duplication.
    if version_2:
        log_rules(project.organization.id, project.id, rules)

    return rules


def generate_rules(project: Project, version_2: bool = False) -> List[PolymorphicRule]:
    try:
        biases_combinator = (
            get_relay_biases_combinator_v2() if version_2 else get_relay_biases_combinator()
        )

        return _get_rules_of_enabled_biases(
            project,
            get_guarded_blended_sample_rate(project),
            get_enabled_user_biases(project.get_option("sentry:dynamic_sampling_biases", None)),
            # To add new biases you will need:
            # * Data provider
            # * Rules generator
            # * Bias
            # check in the dynamic_sampling/rules/biases module how existing biases are implemented.
            biases_combinator.get_combined_biases(),
            version_2,
        )
    except Exception as e:
        sentry_sdk.capture_exception(e)
        return []
