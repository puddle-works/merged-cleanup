include puddle.mk

.PHONY: test
test: ## Run every extension test
	$(DENO) test --allow-read --allow-write --allow-run=git extensions/models/
