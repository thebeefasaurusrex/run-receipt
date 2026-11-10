extends SceneTree

func _initialize() -> void:
	var mode := OS.get_cmdline_user_args()[0]
	var passed := mode != "broken"
	var file := FileAccess.open("res://fixture-result.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"assertions": [
		{"id": "fixture_contract", "passed": passed, "detail": "expected 2, saw 1" if not passed else ""}
	]}))
	file.close()
	if not passed:
		script_failure()
	quit(0 if passed else 1)

func script_failure() -> void:
	var target: Object
	target.call("unreachable")
