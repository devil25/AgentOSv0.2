import json, logging
from .paths import LOGS
logger=logging.getLogger("agentos")
if not logger.handlers:
    logger.setLevel(logging.INFO)
    h=logging.FileHandler(LOGS/"agentos.log",encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
def audit(event, details=None):
    logger.info("%s %s",event,json.dumps(details or {},ensure_ascii=False,default=str))
