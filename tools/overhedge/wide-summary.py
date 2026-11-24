import json,sys
d=json.load(open(sys.argv[1]))
print("files",d.get("numTotalTestSuites"),"tests",d["numTotalTests"],"passed",d["numPassedTests"],"failed",d["numFailedTests"],"pending",d.get("numPendingTests"),"failedSuites",d.get("numFailedTestSuites"))
fails=set()
for r in d["testResults"]:
    f=r["name"].replace("/w/","")
    bad=[a["fullName"] for a in r["assertionResults"] if a["status"]=="failed"]
    if r["status"]=="failed" and not bad:
        fails.add(f+" :: <file failed to run>")
    for b in bad: fails.add(f+" :: "+b)
out=sys.argv[2]
open(out,"w").write("\n".join(sorted(fails))+"\n")
print("failing entries:",len(fails))
