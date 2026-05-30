.DEFAULT_GOAL := help
KIND_CLUSTER ?= devsu

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

test: ## Run unit tests
	cd app && npm ci && npm test

lint: ## Lint the app
	cd app && npm run lint

coverage: ## Run tests with coverage
	cd app && npm run test:coverage

docker-build: ## Build the image
	docker build -t devsu-challenge:local .

compose-up: ## Run app + postgres locally
	docker compose up -d --build

compose-down:
	docker compose down -v

kind-deploy: docker-build ## Build, load and deploy to local kind
	kind load docker-image devsu-challenge:local --name $(KIND_CLUSTER)
	kubectl apply -k k8s/overlays/local-kind

kind-down: ## Delete the kind cluster
	kind delete cluster --name $(KIND_CLUSTER)

tf-plan: ## Terraform plan
	cd terraform && terraform init && terraform plan

tf-apply: ## Terraform apply
	cd terraform && terraform apply

tf-destroy: ## Tear down all Azure infra
	cd terraform && terraform destroy

bootstrap: ## Install AKS add-ons (stage 2)
	./scripts/bootstrap-addons.sh

report: ## Render the PDF report from docs/report.md
	npx md-to-pdf docs/report.md

.PHONY: help test lint coverage docker-build compose-up compose-down kind-deploy kind-down tf-plan tf-apply tf-destroy bootstrap report
