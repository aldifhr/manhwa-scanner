import pytest

from app.scrapers.shinigami_models import (
    ShinigamiDetailResponse,
    ShinigamiLatestResponse,
)


def test_latest_contract_accepts_valid_payload():
    result = ShinigamiLatestResponse.model_validate({"data": [{"manga_id": "42"}]})
    assert result.data[0].manga_id == "42"


def test_latest_contract_rejects_renamed_data_field():
    with pytest.raises(ValueError):
        ShinigamiLatestResponse.model_validate({"results": []})


def test_detail_contract_rejects_non_object_data():
    with pytest.raises(ValueError):
        ShinigamiDetailResponse.model_validate({"data": []})
