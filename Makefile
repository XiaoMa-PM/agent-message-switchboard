.PHONY: check typecheck test python-test pack-check

# What CI runs on every change: types, the Node tests with their coverage floor, and the Python identity and hook client tests.
check: typecheck test python-test

typecheck:
	npm run typecheck

test:
	npm run test:coverage

python-test:
	python3 -m unittest discover -s tests/policy -p 'test_*.py' -v

# Packing smoke test: npm pack, install into a throwaway prefix, ms --version and ms install --dry-run in an empty HOME. Needs the network.
pack-check:
	node scripts/pack-check.mjs
