const
aws = require('./aws.js');
jsel = require('JSONSelect'),
key = require('./key.js'),
sec = require('./sec.js');

const TEMPLATE_IMAGE_ID = 'ami-19cf1670';

function extractInstanceDeets(horribleBlob) {
  var instance = {};
  ["instanceId", "imageId", "instanceState", "dnsName", "keyName", "instanceType",
   "ipAddress"].forEach(function(key) {
     if (horribleBlob[key]) instance[key] = horribleBlob[key];
   });
  var name = jsel.match('.tagSet :has(.key:val("Name")) > .value', horribleBlob);
  if (name.length) {
    instance.fullName = name[0];
    // if this is a 'browserid deployment', we'll only display the hostname chosen by the
    // user
    var m = /^browserid deployment \((.*)\)$/.exec(instance.fullName);
    instance.name = m ? m[1] : instance.fullName;
  } else {
    instance.name = instance.instanceId;
  }
  return instance;
}

exports.list = function(cb) {
  aws.call('DescribeInstances', {}, function(result) {
    var instances = {};
    var i = 1;
    jsel.forEach(
      '.instancesSet > .item:has(.instanceState .name:val("running"))',
      result, function(item) {
        var deets = extractInstanceDeets(item);
        instances[deets.name || 'unknown ' + i++] = deets;
      });
    cb(null, instances);
  });
};

// given something the user typed in, try to figure out what instance they're talking about 
function findInstanceID(r, name) {
  // is what the human typed in an instance id?
  var x = jsel.match("object:has(:root > .instanceId:val(?))", [ name ], r);
  if (x.length) return x[0].instanceId;

  // is what the human typed in the vm "short name" ?
  var fn = "awsbox deployment (" + name + ")";
  var x = jsel.match('.?:has(:root > .instanceId).', [ fn ], r);
  if (x.length) return x[0].instanceId;

  // or did the human type in the full name?
  var x = jsel.match('.?:has(:root > .instanceId).', [ name ], r);
  if (x.length) return x[0].instanceId;

  return undefined;
}

exports.destroy = function(name, cb) {
  exports.list(function(err, r) {
    if (err) return cb('failed to list vms: ' + err);

    instanceId = findInstanceID(r, name);
    if (!instanceId) return cb('no such vm');

    aws.call('TerminateInstances', {
      InstanceId: instanceId
    }, function(result) {
      try { return cb(result.Errors.Error.Message); } catch(e) {};
      cb(null, r[name]);
    });
  });
};

function returnSingleImageInfo(result, cb) {
  if (!result) return cb('no results from ec2 api');
  try { return cb(result.Errors.Error.Message); } catch(e) {};
  try {
    result = jsel.match('.instancesSet > .item', result)[0];
    cb(null, extractInstanceDeets(result));
  } catch(e) {
    return cb("couldn't extract new instance details from ec2 response: " + e);
  }
}

exports.startImage = function(opts, cb) {
  key.getName(function(err, keyName) {
    if (err) return cb(err);
    sec.getName(function(err, groupName) {
      if (err) return cb(err);
      aws.call('RunInstances', {
        ImageId: TEMPLATE_IMAGE_ID,
        KeyName: keyName,
        SecurityGroup: groupName,
        InstanceType: opts.type,
        MinCount: 1,
        MaxCount: 1
      }, function (result) {
        returnSingleImageInfo(result, cb);
      });
    });
  });
};

exports.waitForInstance = function(id, cb) {
  aws.call('DescribeInstanceStatus', {
    InstanceId: id
  }, function(r) {
    if (!r) return cb('no response from ec2');
    // we're waiting and amazon might not have created the image yet!  that's
    // not an error, just an api timing quirk
    var waiting = jsel.match('.Error .Code:val("InvalidInstanceID.NotFound")', r);
    if (waiting.length) {
      return setTimeout(function(){ exports.waitForInstance(id, cb); }, 1000);
    }

    if (!r.instanceStatusSet) return cb('malformed response from ec2' + JSON.stringify(r, null, 2));
    if (Object.keys(r.instanceStatusSet).length) {
      var deets = extractInstanceDeets(r.instanceStatusSet.item);
      if (deets && deets.instanceState && deets.instanceState.name === 'running') {
        return aws.call('DescribeInstances', { InstanceId: id }, function(result) {
          returnSingleImageInfo(result, cb);
        });
      }
    }
    setTimeout(function(){ exports.waitForInstance(id, cb); }, 1000);
  });
};

exports.setName = function(id, name, cb) {
  aws.call('CreateTags', {
    "ResourceId.0": id,
    "Tag.0.Key": 'Name',
    "Tag.0.Value": name
  }, function(result) {
    if (result && result.return === 'true') return cb(null);
    try { return cb(result.Errors.Error.Message); } catch(e) {};
    return cb('unknown error setting instance name');
  });
};
